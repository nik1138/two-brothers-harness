// Two Brothers — browser end-to-end suite (plain Node runner + Playwright).
//
// Scenarios (each hermetic, deterministic, offline unless noted):
//   chat           mock provider: full cooperation cycle in the group chat
//   resume         reload after chat: session list + conversation history
//   approval-allow scripted fixture: approve a workspace write -> file exists, UI shows diff
//   approval-deny  scripted fixture: deny the write -> file absent
//   stop           scripted fixture: stop a slow run -> cancelled state
//   mobile         390px drawer: open/close/Escape/focus and session select
//   appearance-density mock provider: Settings -> Appearance cards stay readable
//                  under compact density; the footer theme switch shrinks and the
//                  preference survives a reload
//   provider-reset mock provider: a built-in seed customized through the API is
//                  reset in Settings -> Providers; pristine flags and both role
//                  assignments survive (offline, no model run)
//   folding        scripted fixture: two work-mode runs whose junior writes two
//                  plan snapshots each; the older run's tool cards fold into a
//                  summary disclosure row (aria-expanded, expand/collapse in
//                  place) while the followed run stays open
//   plan-dock      scripted fixture: three work-mode runs write a 3-item plan,
//                  a 6-item plan (bounded list + "+N more" expand) and an empty
//                  list; the composer-adjacent Plan dock and its polite live
//                  region are asserted ("Plan updated", "Plan cleared.")
//   composer-seats mock provider: the composer status seats show the role model
//                  names from settings and a prompt-audit context breakdown
//                  (chars, no invented token counts); the context seat is
//                  absent until an audit exists
//   hero-starters  mock provider: the welcome/empty hero renders with workspace
//                  context + starters; a starter drafts into an empty composer
//                  (editable, not sent) and never overwrites an existing draft
//   composer-recall mock provider: two accepted submissions are recalled with
//                  ArrowUp (newest first, unsent draft stashed and restored
//                  exactly); a multiline draft only recalls at its absolute
//                  start; recall never submits a run or opens the `/` picker,
//                  and the versioned localStorage history survives a reload
//   approval-reason scripted fixture: a delete approval carries the documented
//                  reason text and the pending card renders it verbatim; its
//                  preview toggle expands the diff as plain text (aria-expanded,
//                  no HTML injection) and collapses again; the allow path still
//                  removes the file
//   real           opt-in (TWO_BROTHERS_REAL_E2E=1): real models via LM Studio
//
// Backend: every scenario runs against the TypeScript server
// (node packages/harness/dist/cli.js serve) with TWO_BROTHERS_PROVIDER=mock or
// a scripted model server, depending on the scenario.
//
// Web build: before any scenario, the runner refreshes the packaged
// `packages/harness/web` copy from `web/dist` when it is stale. The server
// serves the packaged copy first, so a stale copy would silently test old UI
// (see web-freshness.mjs; offline copy, nothing built here).
//
// Fixture-based scenarios drive fixtures/scripted-server.mjs (a scripted
// OpenAI-compatible model server the TS server talks to via
// TWO_BROTHERS_PROVIDER=openai + TWO_BROTHERS_BASE_URL); they are SKIPPED
// (not failed) while the built CLI is missing.
// The real scenario is SKIPPED (not failed) unless TWO_BROTHERS_REAL_E2E=1
// and both LM Studio models are listed by /v1/models.
// Iteration aid (mirrors packages/harness/e2e): TWO_BROTHERS_E2E_ONLY=<substr>
// runs only scenario blocks whose label contains the substring.

import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

import { ensurePackagedWebFresh } from './web-freshness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const TS_CLI = path.join(ROOT, 'packages', 'harness', 'dist', 'cli.js')
const NODE_SCRIPTED = path.join(HERE, 'fixtures', 'scripted-server.mjs')
const WEB_DIST_INDEX = path.join(ROOT, 'web', 'dist', 'index.html')
const WEB_DIST_DIR = path.join(ROOT, 'web', 'dist')
/** The copy the TS server serves first in a checkout (see server.ts). */
const PACKAGED_WEB_DIR = path.join(ROOT, 'packages', 'harness', 'web')
const TASK_TEXT = 'Plan a migration from Redis to Valkey'
const HELLO_FILE = 'e2e-hello.txt'

// -- backend -----------------------------------------------------------------
// The built TypeScript CLI is the only backend; without it every scenario is
// reported as SKIP instead of being attempted.
const tsAvailable = fs.existsSync(TS_CLI)

// -- real-model scenario (opt-in) ------------------------------------------------
// LM Studio serves both roles over the OpenAI-compatible API; no api_key needed.
const LMSTUDIO_BASE = process.env.TWO_BROTHERS_LM_BASE || 'http://172.18.0.1:1234/v1'
// Role model ids default to the LM Studio pair; any OpenAI-compatible endpoint
// can be driven by overriding them (and TWO_BROTHERS_LM_BASE).
const SENIOR_MODEL = process.env.TWO_BROTHERS_E2E_SENIOR_MODEL || 'spark-x2.6-4b@q4_k_m'
const JUNIOR_MODEL = process.env.TWO_BROTHERS_E2E_JUNIOR_MODEL || 'lfm3-1.7b'
const REAL_TASK = 'In one sentence: what is a reversible migration?'
const REAL_DEADLINE_MS = Number(process.env.TWO_BROTHERS_E2E_DEADLINE_MS) || 10 * 60 * 1000
const LM_PROBE_MS = 5000

// Optional iteration filter for scenario blocks (empty = the full suite).
const ONLY_SCENARIO = (process.env.TWO_BROTHERS_E2E_ONLY ?? '').trim().toLowerCase()
const scenarioSelected = (label) => !ONLY_SCENARIO || label.toLowerCase().includes(ONLY_SCENARIO)

/** In-scenario skip: reported as SKIP (never FAIL), like a missing fixture. */
class SkipError extends Error {}

const results = []
const children = new Set()
let browser = null
let browserLabel = ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// All E2E temp dirs live under <repo>/.e2e-tmp (gitignored), not os.tmpdir().
const TMP_ROOT = path.join(ROOT, '.e2e-tmp')
function tmpDir(prefix) {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`))
}

// Node's fs.rmSync(..., {recursive:true}) silently no-ops on this machine
// (OneDrive-synced tree); walking + unlink + rmdir works. Retry for handles
// released shortly after the backend process is killed.
function rmTree(target, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      walkRemove(target)
      return
    } catch (e) {
      if (i === attempts - 1) throw e
      // synchronous 300 ms pause
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    }
  }
}

function walkRemove(target) {
  if (!fs.existsSync(target)) return
  const st = fs.lstatSync(target)
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) walkRemove(path.join(target, entry))
    fs.rmdirSync(target)
  } else {
    fs.unlinkSync(target)
  }
}

function log(msg) {
  process.stdout.write(msg + '\n')
}

// -- browser console guard ------------------------------------------------------
// Every scenario attaches this collector and asserts before passing, so any
// app-side console error / uncaught page error (e.g. a TypeError inside a Vue
// computed) fails the scenario instead of passing silently.
function attachConsoleGuard(page) {
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })
  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message ?? String(e)}`)
  })
  return {
    assertClean() {
      assert.ok(
        errors.length === 0,
        `browser console must stay clean — got ${errors.length} error(s):\n${errors.join('\n')}`,
      )
    },
  }
}

/**
 * One browser context + page + console guard for a scenario. The caller closes
 * the context (and kills the backend) in its `finally`.
 */
async function newScenarioPage() {
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  return { context, page, consoleGuard }
}

/** Resolve a session file name from its readable title (API-side event checks). */
async function sessionNameByTitle(base, title) {
  const sessions = await (await fetch(`${base}/api/sessions`)).json()
  const match = sessions.find((session) => session.title === title)
  assert.ok(match, `session titled "${title}" missing from /api/sessions`)
  return match.name
}

// -- web build ----------------------------------------------------------------

async function ensureWebBuild() {
  if (fs.existsSync(WEB_DIST_INDEX)) return
  log('web/dist missing — running `npm run build` in web/ ...')
  await new Promise((resolve, reject) => {
    const p = spawn('npm', ['run', 'build'], {
      cwd: path.join(ROOT, 'web'),
      stdio: 'inherit',
      windowsHide: true,
    })
    children.add(p)
    p.on('exit', (code) => {
      children.delete(p)
      code === 0 ? resolve() : reject(new Error(`web build failed (exit ${code})`))
    })
  })
  if (!fs.existsSync(WEB_DIST_INDEX)) throw new Error('web build produced no dist/index.html')
}

/**
 * The backend serves the packaged `packages/harness/web` copy before the repo's
 * `web/dist` (see `packages/harness/src/server.ts`), so a stale packaged copy
 * silently shadows a fresh web build and the suite would test old UI. Compare
 * the trees by path set + file content and re-run the publisher's copy (the same
 * `cpSync` as `scripts/sync-web.mjs`, building nothing) when they differ. This
 * is a local file copy — still offline, hermetic and deterministic — and fresh
 * trees are a no-op; a missing build fails with the exact command to run.
 */
function ensureFreshPackagedWeb() {
  const freshness = ensurePackagedWebFresh({
    sourceDir: WEB_DIST_DIR,
    targetDir: PACKAGED_WEB_DIR,
  })
  if (freshness.synced) {
    log(
      `packaged web: resynced packages/harness/web from web/dist ` +
        `(${freshness.files} files; ${freshness.reasons.join('; ')})`,
    )
  } else {
    log(`packaged web: fresh (${freshness.files} files)`)
  }
}

// -- free ports ----------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function portFree(port, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const free = await new Promise((resolve) => {
      const sock = new Socket()
      sock.setTimeout(800)
      sock.once('connect', () => {
        sock.destroy()
        resolve(false)
      })
      sock.once('timeout', () => {
        sock.destroy()
        resolve(false)
      })
      sock.once('error', () => resolve(true))
      sock.connect(port, '127.0.0.1')
    })
    if (free) return true
    await sleep(250)
  }
  return false
}

// -- backend process management -------------------------------------------------

/** Spawn a server process; returns a handle with kill() that reaps the tree. */
function spawnServer(args, label, { bin = process.execPath, env = process.env } = {}) {
  const p = spawn(bin, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(p)
  p.stderr?.on('data', () => {})
  p.stdout?.on('data', () => {})
  const handle = {
    pid: p.pid,
    async kill() {
      if (p.exitCode !== null || p.signalCode) return
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () =>
          resolve(),
        )
      })
      // reap zombies / stragglers
      for (let i = 0; i < 20 && p.exitCode === null; i++) await sleep(100)
    },
  }
  p.on('exit', () => children.delete(p))
  return handle
}

async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await sleep(250)
  }
  throw new Error(`server on :${port} did not become ready (${lastErr?.message ?? 'timeout'})`)
}

/** Poll the scripted model server's /v1/models until it answers. */
async function waitForModelServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await sleep(250)
  }
  throw new Error(`scripted model server on :${port} did not become ready (${lastErr?.message ?? 'timeout'})`)
}

/** Ambient TWO_BROTHERS_* provider env must never leak into a TS run:
 *  every scenario pins exactly the provider connection it needs. */
function tsEnv(overrides = {}) {
  const env = { ...process.env }
  for (const key of [
    'TWO_BROTHERS_PROVIDER',
    'TWO_BROTHERS_BASE_URL',
    'TWO_BROTHERS_API_KEY',
    'TWO_BROTHERS_SENIOR_MODEL',
    'TWO_BROTHERS_JUNIOR_MODEL',
  ]) {
    delete env[key]
  }
  return { ...env, ...overrides }
}

/**
 * Start the TypeScript backend; waits for readiness; always pair with
 * killBackend().
 *   kind     'mock'     -> the backend's built-in deterministic mock provider
 *            'fixture'  -> scripted deterministic responses:
 *                          fixtures/scripted-server.mjs is an
 *                          OpenAI-compatible model server the backend talks to
 *                          (provider=openai)
 *   scenario fixture scenario name (approval | slow | plan | folding)
 *   lingerMs optional --linger-ms forwarded to the fixture (slow's first
 *            answer delay; folding's second-run deliverable delay)
 * The returned handle may carry a `modelServer` (fixture runs) that
 * killBackend() tears down with the backend itself.
 */
async function startBackend({ kind, scenario, lingerMs }) {
  const port = await freePort()
  const dir = tmpDir('tb-e2e-ts')
  let modelServer = null
  let env
  if (kind === 'mock') {
    env = tsEnv({ TWO_BROTHERS_PROVIDER: 'mock' })
  } else {
    const modelPort = await freePort()
    const modelArgs = [NODE_SCRIPTED, '--port', String(modelPort), '--scenario', scenario]
    if (Number.isFinite(lingerMs)) modelArgs.push('--linger-ms', String(lingerMs))
    modelServer = spawnServer(modelArgs, 'ts-model')
    await waitForModelServer(modelPort)
    env = tsEnv({
      TWO_BROTHERS_PROVIDER: 'openai',
      TWO_BROTHERS_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      TWO_BROTHERS_SENIOR_MODEL: 'e2e-senior',
      TWO_BROTHERS_JUNIOR_MODEL: 'e2e-junior',
    })
  }
  const server = spawnServer(
    [TS_CLI, 'serve', '--host', '127.0.0.1', '--port', String(port), '--sessions-dir', dir],
    `ts-${kind}`,
    { env },
  )
  await waitForServer(port)
  return { port, dir, server, modelServer, base: `http://127.0.0.1:${port}` }
}

async function killBackend(be) {
  await be.server.kill()
  if (be.modelServer) await be.modelServer.kill()
  if (!(await portFree(be.port))) {
    throw new Error(`port ${be.port} still occupied after kill`)
  }
}

/** Sibling of startBackend() for a plain `serve` — no --provider mock,
 *  no scripted fixture; role models come from PUT /api/settings instead. */
async function startPlainBackend() {
  const port = await freePort()
  const dir = tmpDir('tb-e2e-real')
  const server = spawnServer(
    [TS_CLI, 'serve', '--host', '127.0.0.1', '--port', String(port), '--sessions-dir', dir],
    'real',
    { env: tsEnv() },
  )
  await waitForServer(port)
  return { port, dir, server, modelServer: null, base: `http://127.0.0.1:${port}` }
}

// -- real-model probes ------------------------------------------------------------

/** Model ids advertised by LM Studio, or an empty set on any failure. */
async function probeLmStudio() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LM_PROBE_MS)
  try {
    const res = await fetch(`${LMSTUDIO_BASE}/models`, { signal: ctrl.signal })
    if (!res.ok) return new Set()
    const data = await res.json()
    return new Set((data.data ?? []).map((m) => m.id))
  } catch {
    return new Set()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Follow /api/runs/{run_id}/events until the run_end event (or the deadline).
 *
 * The single-shot fetch proved flaky on this machine: Windows severs the
 * long-lived SSE socket mid-run (undici `TypeError: terminated`), and a
 * silently hung connection otherwise sat until the deadline. This follower
 * therefore mirrors the app's own EventSource contract: it tracks the SSE
 * `id:` cursor and reconnects with `?after=N` after any error or premature
 * close, while keeping the hard overall deadline unchanged. A stall is
 * reported with the run record's status so a slow/stuck model (product
 * behavior) is distinguishable from a lost test-client stream.
 */
async function followRunEvents(base, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const events = []
  let after = 0
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      let record = 'unreachable'
      try {
        const rec = await (await fetch(`${base}/api/runs/${runId}`)).json()
        record = `${rec.status}${rec.error ? ` (${String(rec.error).slice(0, 200)})` : ''}`
      } catch {}
      throw new Error(
        `run ${runId} did not reach run_end within ${Math.round(timeoutMs / 60000)} min ` +
          `(run record at deadline: ${record})`,
      )
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), remaining)
    try {
      const res = await fetch(`${base}/api/runs/${runId}/events?after=${after}`, {
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) throw new Error(`GET events -> HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const idLine = block.split('\n').find((l) => l.startsWith('id: '))
          const cursor = idLine ? Number(idLine.slice(4)) : NaN
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue
            if (Number.isFinite(cursor)) after = cursor
            const ev = JSON.parse(line.slice('data: '.length))
            events.push(ev)
            if (ev.type === 'run_end') return events
          }
        }
      }
      // The backend closes the response only after delivering run_end; an
      // early close is a dropped connection — reconnect from the cursor.
      log(`[real] SSE stream closed before run_end (after=${after}) — reconnecting`)
    } catch (e) {
      if (e?.name === 'AbortError') {
        // overall deadline — diagnosed at the top of the next iteration
      } else {
        log(`[real] SSE follow error: ${e.message} — reconnecting after=${after}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

// -- browser --------------------------------------------------------------------

async function launchBrowser() {
  const attempts = [
    { label: 'msedge (headless)', opts: { channel: 'msedge', headless: true } },
    { label: 'chrome (headless)', opts: { channel: 'chrome', headless: true } },
    { label: 'msedge (headful)', opts: { channel: 'msedge', headless: false } },
    { label: 'chrome (headful)', opts: { channel: 'chrome', headless: false } },
  ]
  const errors = []
  for (const a of attempts) {
    try {
      browser = await chromium.launch(a.opts)
      browserLabel = a.label
      return
    } catch (e) {
      errors.push(`${a.label}: ${e.message.split('\n')[0]}`)
    }
  }
  throw new Error(`no browser could be launched:\n  ${errors.join('\n  ')}`)
}

// -- waiting helper ---------------------------------------------------------------

async function waitFor(fn, { timeout = 15000, interval = 250, desc = 'condition' } = {}) {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      lastErr = e
    }
    await sleep(interval)
  }
  throw new Error(
    `timeout (${timeout} ms) waiting for ${desc}${lastErr ? ` — last error: ${lastErr.message}` : ''}`,
  )
}

// -- shared UI steps ----------------------------------------------------------------

async function addWorkspaceViaDialog(page, dirPath) {
  await page.click('button[aria-label="Add workspace"]')
  const dialog = page.locator('[role="dialog"][aria-label="Add workspace"]')
  await dialog.waitFor({ state: 'visible' })
  // the workspace finder: edit the path directly, then confirm the current folder
  await dialog.locator('button[aria-label="Edit path"]').click()
  const pathInput = dialog.locator('input[aria-label="Folder path"]')
  await pathInput.fill(dirPath)
  await pathInput.press('Enter')
  await waitFor(
    async () =>
      (await dialog.locator('.wsf-current-path').innerText()).trim() === dirPath,
    { desc: 'finder to list the target folder' },
  )
  await dialog.getByRole('button', { name: 'Add workspace', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 10000 })
}

async function workspaceOptions(page) {
  return page.locator('select[title="Filter sessions by workspace"] option').allInnerTexts()
}

/** Ensure the sidebar filter offers `name`; add the workspace via the UI if
 *  not. App.vue refreshes the workspace list on `workspace-created`, so no
 *  page reload is needed after adding. */
async function ensureWorkspace(page, dirPath, name) {
  const opts = await workspaceOptions(page)
  if (opts.includes(name)) return
  await addWorkspaceViaDialog(page, dirPath)
  await waitFor(async () => (await workspaceOptions(page)).includes(name), {
    desc: `workspace "${name}" in filter`,
  })
}

async function selectWorkspaceFilter(page, name) {
  await page.locator('select[title="Filter sessions by workspace"]').selectOption({ label: name })
}

async function createSession(page, title) {
  await page.click('button[aria-label="New session"]')
  const dialog = page.locator('[role="dialog"][aria-label="New session"]')
  await dialog.waitFor({ state: 'visible' })
  if (title) await dialog.locator('input').first().fill(title)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 10000 })
  await page.locator('.chat-scroll').waitFor({ state: 'visible' })
}

const MODE_LABELS = { consult: 'Consult', work: 'Work', auto: 'Auto' }

/** Open the composer's cooperation-mode popover and pick a mode. */
async function chooseMode(page, mode) {
  await page.locator('button[data-testid="composer-mode"]').click()
  const menu = page.locator('#composer-mode-menu')
  await menu.waitFor({ state: 'visible' })
  await menu.locator(`.mode-option:has(.mode-title:text-is("${MODE_LABELS[mode]}"))`).click()
}

/**
 * Send a task. The provider is never chosen in the composer anymore: it comes
 * from the backend environment (TWO_BROTHERS_PROVIDER / scripted fixture) or
 * the `?provider=` dev URL flag — scenarios pin it via startBackend's env.
 */
async function sendTask(page, task, { mode = 'consult' } = {}) {
  if (mode !== 'consult') await chooseMode(page, mode)
  await page.locator('textarea.composer-input').fill(task)
  await page.locator('textarea.composer-input').press('Enter')
}

/** Wait until the followed run finishes (Stop button gone, Send visible again). */
async function waitForRunEnd(page, timeout = 90000) {
  await waitFor(
    async () =>
      (await page.locator('form[aria-label="New task"] button:has-text("Stop")').count()) === 0 &&
      (await page.locator('form[aria-label="New task"] button[type="submit"]').count()) === 1,
    { timeout, desc: 'run to finish (Send button back)' },
  )
}

// -- scenario: chat + resume --------------------------------------------------------

async function scenarioChat(runner) {
  const be = await startBackend({ kind: 'mock' })
  const wsDir = tmpDir("tb-e2e-ws-chat")
  const wsName = path.basename(wsDir)
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, 'E2E chat session')

    await sendTask(page, TASK_TEXT)
    await waitForRunEnd(page)

    // the run-end reload of persisted envelopes is async — wait for content first
    const decision = page.locator('.chat-group.side-senior .bubble.bubble-highlight')
    await decision.waitFor({ timeout: 15000 })

    // three distinct speakers
    for (const side of ['side-operator', 'side-senior', 'side-junior']) {
      assert.ok(
        (await page.locator(`.chat-group.${side}`).count()) >= 1,
        `expected at least one .chat-group.${side}`,
      )
    }
    const speakers = new Set(
      await page.locator('.chat-group .speaker-name').allInnerTexts(),
    )
    for (const who of ['You', 'Senior', 'Junior']) {
      assert.ok(speakers.has(who), `speaker "${who}" missing (got: ${[...speakers].join(', ')})`)
    }

    // final senior decision, highlighted
    assert.equal(await decision.count(), 1, 'expected exactly one highlighted senior decision')
    const kindChip = await decision.locator('.kind-chip').innerText()
    assert.equal(kindChip.trim().toLowerCase(), 'decision')

    // no raw protocol JSON / transcript markers leaked into the UI
    const transcript = await page.locator('.chat-scroll').innerText()
    assert.ok(!transcript.includes('{"v":1'), 'raw protocol JSON visible in chat')
    assert.ok(!transcript.includes('[[TASK]]'), 'raw [[TASK]] marker visible in chat')
    assert.ok(
      !transcript.includes('[[REPAIR_REQUEST]]'),
      'raw [[REPAIR_REQUEST]] marker visible in chat',
    )

    consoleGuard.assertClean()
    runner.pass('chat')

    // -- resume: reload, session list + history
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    const item = page.locator('.session-item', { hasText: 'E2E chat session' })
    assert.ok((await item.count()) === 1, 'session with readable title missing after reload')
    await item.first().click()
    await page.locator('.chat-group.side-senior .bubble.bubble-highlight').first().waitFor()
    const history = await page.locator('.chat-scroll').innerText()
    assert.ok(history.includes(TASK_TEXT.slice(0, 20)), 'conversation history not rendered')
    assert.ok(!history.includes('{"v":1'), 'raw protocol JSON visible after reload')
    assert.ok(!history.includes('[[REPAIR_REQUEST]]'), 'raw [[REPAIR_REQUEST]] marker after reload')

    consoleGuard.assertClean()
    runner.pass('resume')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

/** Assert a locator's box lies fully inside the viewport (nothing clipped
 *  by composer/footer chrome). */
async function assertFullyVisible(page, locator, label) {
  const box = await locator.boundingBox()
  const vp = page.viewportSize()
  assert.ok(box && vp, `${label}: element has no bounding box`)
  assert.ok(
    box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0 && box.x + box.width <= vp.width,
    `${label} not fully visible in viewport (box=${JSON.stringify(box)}, viewport=${vp.width}x${vp.height})`,
  )
}

// -- scenario: approval (allow / deny) ------------------------------------------------

async function approvalFlow(runner, decision) {
  const wsDir = tmpDir(`tb-e2e-ws-appr-${decision}`)
  const wsName = path.basename(wsDir)
  const be = await startBackend({ kind: 'fixture', scenario: 'approval' })
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  const helloPath = path.join(wsDir, HELLO_FILE)
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, `E2E approval ${decision}`)
    // let the scripted server drive: provider comes from the backend env
    await sendTask(page, 'Write the hello file in the workspace', { mode: 'work' })

    const card = page.locator('article.approval', { hasText: 'awaiting you' })
    await card.first().waitFor({ timeout: 30000 })

    // the active request is docked above the composer, fully visible and
    // clickable — never clipped behind the composer or the usage footer
    const dock = page.locator('.approval-dock')
    await dock.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(
      await card.count(),
      1,
      `expected exactly one pending approval card (dock + timeline duplicate?), got ${await card.count()}`,
    )
    const decideBtn = dock.locator(
      'button.approval-btn',
      { hasText: decision === 'allow' ? 'Allow' : 'Deny' },
    )
    await assertFullyVisible(page, dock.locator('article.approval'), 'docked approval card')
    await assertFullyVisible(page, decideBtn, `${decision} button`)

    // the scripted fixture answers a structured reply badly once, so the run
    // emits a REPAIR_REQUEST envelope: it must surface as a neutral system
    // activity, never as a raw marker / operator bubble
    const systemActivity = page.locator('.system-activity')
    await systemActivity.first().waitFor({ timeout: 10000 })
    const activityText = await systemActivity.first().innerText()
    assert.ok(
      !activityText.includes('[[REPAIR_REQUEST]]'),
      'raw [[REPAIR_REQUEST]] marker visible in the repair activity',
    )
    const transcriptNow = await page.locator('.chat-scroll').innerText()
    assert.ok(
      !transcriptNow.includes('[[REPAIR_REQUEST]]'),
      'raw [[REPAIR_REQUEST]] marker visible in chat',
    )

    await decideBtn.click()

    await waitForRunEnd(page)

    if (decision === 'allow') {
      assert.ok(fs.existsSync(helloPath), `${helloPath} was not written after approval`)
      const diffPath = page.locator(
        'section[aria-label="Changed files"] .diff-review-file-path',
        { hasText: HELLO_FILE },
      )
      await diffPath.first().waitFor({ timeout: 10000 })
    } else {
      assert.ok(!fs.existsSync(helloPath), `${helloPath} exists although the write was denied`)
      await page
        .locator('article.approval .approval-status.approval-rejected')
        .first()
        .waitFor({ timeout: 10000 })
    }
    consoleGuard.assertClean()
    runner.pass(`approval-${decision}`)
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: stop --------------------------------------------------------------------

async function scenarioStop(runner) {
  const wsDir = tmpDir('tb-e2e-ws-stop')
  const wsName = path.basename(wsDir)
  const be = await startBackend({ kind: 'fixture', scenario: 'slow' })
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, 'E2E stop')
    await sendTask(page, 'Start a long-running task', { mode: 'consult' })

    const stopBtn = page.locator('form[aria-label="New task"] button:has-text("Stop")')
    await stopBtn.waitFor({ timeout: 30000 })
    // let the run actually start before stopping it
    await sleep(1500)
    await stopBtn.click()

    await page
      .locator('.toast', { hasText: 'Run stopped' })
      .first()
      .waitFor({ timeout: 20000 })

    // backend agrees the run is no longer running
    const runs = await (await fetch(`${be.base}/api/runs`)).json()
    assert.ok(
      runs.every((r) => r.status !== 'running' && r.status !== 'queued'),
      `backend still reports an active run: ${JSON.stringify(runs.map((r) => r.status))}`,
    )
    consoleGuard.assertClean()
    runner.pass('stop')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: mobile drawer (390px) -----------------------------------------------------
// Below 768px the sidebar starts closed, opens as an accessible drawer
// (Escape / backdrop / inert chat / focus), and closes on session select.

async function scenarioMobile(runner) {
  const wsDir = tmpDir('tb-e2e-ws-mobile')
  const wsName = path.basename(wsDir)
  const be = await startBackend({ kind: 'mock' })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  try {
    await page.goto(be.base)
    const nav = page.locator('nav[aria-label="Sessions"]')
    const expand = page.locator('button[aria-label="Show sessions"]')

    // initial viewport below 768px: the sidebar starts closed
    assert.equal(await nav.count(), 0, 'sidebar must start closed on a 390px viewport')
    await expand.waitFor({ state: 'visible' })

    // open: drawer visible, chat inert, backdrop present
    await expand.click()
    await nav.waitFor({ state: 'visible' })
    assert.ok(
      await page.evaluate(() =>
        document.querySelector('.chat-shell')?.hasAttribute('inert'),
      ),
      'chat shell must be inert while the drawer is open',
    )
    await page.locator('.sidebar-backdrop').waitFor({ state: 'visible' })

    // Escape closes and restores focus to the trigger
    await page.keyboard.press('Escape')
    await nav.waitFor({ state: 'hidden' })
    assert.ok(
      await page.evaluate(
        () => document.activeElement === document.querySelector('button.sidebar-expand'),
      ),
      'focus must return to the expand button after Escape closes the drawer',
    )

    // backdrop click closes (click beside the drawer, not under it)
    await expand.click()
    await nav.waitFor({ state: 'visible' })
    await page
      .locator('.sidebar-backdrop')
      .click({ position: { x: 380, y: 420 } })
    await nav.waitFor({ state: 'hidden' })

    // creating a session loads it and closes the drawer
    await expand.click()
    await nav.waitFor({ state: 'visible' })
    await ensureWorkspace(page, wsDir, wsName)
    await createSession(page, 'E2E mobile session')
    await nav.waitFor({ state: 'hidden' })
    assert.ok(
      !(await page.evaluate(() =>
        document.querySelector('.chat-shell')?.hasAttribute('inert'),
      )),
      'chat shell must not stay inert after the drawer closes',
    )

    // selecting a session from the drawer closes it too
    await expand.click()
    await nav.waitFor({ state: 'visible' })
    await page.locator('.session-item', { hasText: 'E2E mobile session' }).first().click()
    await nav.waitFor({ state: 'hidden' })
    await page.locator('.chat-scroll').waitFor({ state: 'visible' })

    consoleGuard.assertClean()
    runner.pass('mobile')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: Settings -> Appearance under compact density (regression) ---------------
// Compact density may shrink the sidebar footer theme switch only. The
// Settings -> Appearance cards (theme + density) must keep their natural
// height and never clip their copy in either density, and the density choice
// must survive a reload (the pre-paint bootstrap in index.html restores it).

/** Open Settings -> Appearance and return the dialog + visible section pane. */
async function openAppearanceSettings(page) {
  await page.locator('.sidebar-footer .footer-action').click()
  const dialog = page.locator('[role="dialog"][aria-labelledby="settings-dialog-title"]')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: 'Appearance' }).click()
  const pane = dialog.locator('[role="region"][aria-label="Appearance"]')
  await pane.waitFor({ state: 'visible' })
  await pane.locator('.appearance-card').first().waitFor({ state: 'visible' })
  return { dialog, pane }
}

/** Measure the Appearance cards and the sidebar footer theme switch. */
async function measureAppearanceDensity(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 10) / 10
    const cards = [
      ...document.querySelectorAll(
        '[role="region"][aria-label="Appearance"] .appearance-card',
      ),
    ]
    const footer = [...document.querySelectorAll('.sidebar .theme-switch .theme-option')]
    return {
      density: document.documentElement.getAttribute('data-density'),
      cards: cards.map((card) => {
        const box = card.getBoundingClientRect()
        const copy = card.querySelector('.appearance-copy')
        const copyBox = copy ? copy.getBoundingClientRect() : null
        return {
          firstWord: (card.textContent ?? '').trim().split(/\s+/)[0] ?? '',
          height: round(box.height),
          overflowY: card.scrollHeight - card.clientHeight,
          copyInside:
            copyBox === null ||
            (copyBox.top >= box.top - 0.5 && copyBox.bottom <= box.bottom + 0.5),
        }
      }),
      footerHeights: footer.map((option) => round(option.getBoundingClientRect().height)),
    }
  })
}

async function scenarioAppearanceDensity(runner) {
  const be = await startBackend({ kind: 'mock' })
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    // comfortable is the default: the shell writes the attribute on mount
    const { pane } = await openAppearanceSettings(page)
    const comfortable = await measureAppearanceDensity(page)
    assert.equal(comfortable.density, 'comfortable', 'comfortable density is the default')
    assert.equal(
      comfortable.cards.length,
      5,
      `expected 3 theme + 2 density cards, got ${comfortable.cards.length}`,
    )
    for (const card of comfortable.cards) {
      assert.ok(
        card.height >= 48,
        `comfortable Appearance card "${card.firstWord}" is ${card.height}px (expected >= 48)`,
      )
      assert.ok(
        card.overflowY <= 1,
        `comfortable Appearance card "${card.firstWord}" overflows by ${card.overflowY}px`,
      )
      assert.ok(card.copyInside, `comfortable Appearance card "${card.firstWord}" clips its copy`)
    }
    const comfortableFooter = comfortable.footerHeights
    assert.equal(comfortableFooter.length, 3, 'expected three footer theme options')
    assert.ok(comfortableFooter.every((height) => height > 0), 'footer theme options are measurable')

    // switch density through the Appearance card itself
    await pane.locator('.appearance-card', { hasText: 'Compact' }).first().click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-density') === 'compact',
      null,
      { timeout: 5000 },
    )
    const compact = await measureAppearanceDensity(page)
    assert.equal(compact.density, 'compact', 'compact density must be applied')
    for (const card of compact.cards) {
      assert.ok(
        card.height >= 48,
        `compact density squashed the Appearance card "${card.firstWord}" to ${card.height}px`,
      )
      assert.ok(
        card.overflowY <= 1,
        `compact Appearance card "${card.firstWord}" overflows by ${card.overflowY}px`,
      )
      assert.ok(card.copyInside, `compact Appearance card "${card.firstWord}" clips its copy`)
    }
    assert.equal(compact.footerHeights.length, 3, 'expected three footer theme options')
    for (const height of compact.footerHeights) {
      assert.ok(height <= 28, `footer theme option is ${height}px (expected <= 28 in compact)`)
    }
    assert.ok(
      compact.footerHeights.every((height, index) => height < comfortableFooter[index]),
      `footer theme switch must shrink under compact density ` +
        `(${comfortableFooter.join('px,')}px -> ${compact.footerHeights.join('px,')}px)`,
    )

    // the preference survives a reload and the cards still render naturally
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    assert.equal(
      await page.evaluate(() => document.documentElement.getAttribute('data-density')),
      'compact',
      'compact density must survive a reload',
    )
    await openAppearanceSettings(page)
    const reloaded = await measureAppearanceDensity(page)
    assert.equal(reloaded.density, 'compact', 'reloaded document keeps compact density')
    for (const card of reloaded.cards) {
      assert.ok(
        card.height >= 48,
        `reloaded Appearance card "${card.firstWord}" is ${card.height}px (expected >= 48)`,
      )
      assert.ok(card.copyInside, `reloaded Appearance card "${card.firstWord}" clips its copy`)
    }
    assert.ok(
      reloaded.footerHeights.every((height) => height <= 28),
      `reloaded footer theme options must stay compact (${reloaded.footerHeights.join('px,')}px)`,
    )

    consoleGuard.assertClean()
    runner.pass('appearance-density')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: Settings -> Providers -> Reset to default ----------------------------
// A seeded preset is customized through the public API (the UI edit form would be
// a second, heavier flow), then reset through the visible Settings -> Providers
// control and its confirmation dialog. Reset must discard only the stored
// override: both roles keep their provider_ref/model, an unrelated custom
// provider survives, and no key material reaches the DOM or an API response.
// The backend is the deterministic mock, so this scenario opens no model server
// and never makes a model call.

const RESET_SEED = 'lmstudio'
const RESET_OVERRIDE_BASE = 'https://e2e-provider-reset.invalid/v1'
const RESET_OVERRIDE_KIND = 'anthropic'
const RESET_OVERRIDE_MODEL = 'e2e-reset-override-model'
const RESET_OVERRIDE_SECRET = 'sk-e2e-reset-override-6b1f4c'
const RESET_UNRELATED_NAME = 'e2e-unrelated'
const RESET_UNRELATED_BASE = 'http://127.0.0.1:5999/v1'
const RESET_UNRELATED_SECRET = 'sk-e2e-reset-unrelated-9d2e7a'
const RESET_SENIOR_MODEL = 'e2e-senior-before-reset'
const RESET_JUNIOR_MODEL = 'e2e-junior-before-reset'
const RESET_PRISTINE = {
  name: RESET_SEED,
  base_url: 'http://localhost:1234/v1',
  api_key_set: false,
  kind: 'openai-compatible',
  models: ['spark-x2.6-4b@q4_k_m', 'lfm3-1.7b'],
  seed: true,
  customized: false,
}

/** Minimal JSON request helper for the API-backed setup/assertions. */
async function apiCall(base, method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json }
}

async function scenarioProviderReset(runner) {
  const be = await startBackend({ kind: 'mock' })
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  try {
    // -- setup through the API: customize the seed, keep both roles on it, add
    //    an unrelated provider that reset must not touch
    const customized = await apiCall(be.base, 'PUT', `/api/providers/${RESET_SEED}`, {
      base_url: RESET_OVERRIDE_BASE,
      api_key: RESET_OVERRIDE_SECRET,
      kind: RESET_OVERRIDE_KIND,
      models: [RESET_OVERRIDE_MODEL],
    })
    assert.equal(customized.status, 200, `PUT provider -> HTTP ${customized.status}: ${customized.text}`)
    assert.equal(customized.json.provider.base_url, RESET_OVERRIDE_BASE)
    assert.equal(customized.json.provider.api_key_set, true)
    assert.equal(customized.json.provider.kind, RESET_OVERRIDE_KIND)
    assert.deepEqual(customized.json.provider.models, [RESET_OVERRIDE_MODEL])
    assert.ok(
      !customized.text.includes(RESET_OVERRIDE_SECRET),
      'PUT /api/providers echoed the API key',
    )
    // The additive seed/customized flags live on GET, not on the PUT response.
    const customizedList = (await (await fetch(`${be.base}/api/providers`)).json()).providers
    assert.deepEqual(customizedList.find((provider) => provider.name === RESET_SEED), {
      name: RESET_SEED,
      base_url: RESET_OVERRIDE_BASE,
      api_key_set: true,
      kind: RESET_OVERRIDE_KIND,
      models: [RESET_OVERRIDE_MODEL],
      seed: true,
      customized: true,
    })

    const unrelated = await apiCall(be.base, 'POST', '/api/providers', {
      name: RESET_UNRELATED_NAME,
      base_url: RESET_UNRELATED_BASE,
      api_key: RESET_UNRELATED_SECRET,
      models: ['unrelated-model'],
    })
    assert.equal(
      unrelated.status,
      201,
      `POST unrelated provider -> HTTP ${unrelated.status}: ${unrelated.text}`,
    )

    const configured = await apiCall(be.base, 'PUT', '/api/settings', {
      senior: { provider_ref: RESET_SEED, model: RESET_SENIOR_MODEL },
      junior: { provider_ref: RESET_SEED, model: RESET_JUNIOR_MODEL },
    })
    assert.equal(configured.status, 200, `PUT settings -> HTTP ${configured.status}: ${configured.text}`)
    assert.equal(configured.json.senior.provider_ref, RESET_SEED)
    assert.equal(configured.json.junior.provider_ref, RESET_SEED)
    assert.equal(configured.json.senior.model, RESET_SENIOR_MODEL)
    assert.equal(configured.json.junior.model, RESET_JUNIOR_MODEL)

    // -- the visible flow
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    await page.locator('.sidebar-footer .footer-action').click()
    const settings = page.locator('[role="dialog"][aria-labelledby="settings-dialog-title"]')
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('button', { name: 'Providers', exact: true }).click()
    const pane = settings.locator('[role="region"][aria-label="Providers"]')
    await pane.waitFor({ state: 'visible' })

    const row = pane.locator('.provider-row').filter({
      has: page.locator('.provider-row-name', { hasText: /^lmstudio$/ }),
    })
    await row.waitFor({ state: 'visible' })
    assert.equal(
      (await row.locator('.provider-row-tag').innerText()).trim(),
      'Customized',
      'customized seed must be tagged in the list',
    )
    assert.deepEqual(
      await row.locator('.provider-role').allInnerTexts(),
      ['Senior', 'Junior'],
      'both roles must be badged on the seed row before reset',
    )
    assert.equal(await row.locator('.provider-key-dot').getAttribute('aria-label'), 'API key set')

    await row.click()
    const detail = pane.locator('.provider-detail')
    await detail.waitFor({ state: 'visible' })
    assert.equal((await detail.locator('.provider-detail-title').innerText()).trim(), RESET_SEED)
    const badges = (await detail.locator('.provider-badge').allInnerTexts()).map((text) =>
      text.trim(),
    )
    assert.ok(badges.includes('Built-in'), `missing Built-in badge (got: ${badges.join(', ')})`)
    assert.ok(badges.includes('Customized'), `missing Customized badge (got: ${badges.join(', ')})`)
    assert.deepEqual(
      await detail.locator('.provider-badge.is-role').allInnerTexts(),
      ['Used by Senior', 'Used by Junior'],
      'both role assignments must show in the detail before reset',
    )
    assert.equal(
      (await detail.locator('.provider-kind-chip').innerText()).trim(),
      'Anthropic',
      'the override kind must render before reset',
    )

    const baseField = detail.locator('label.provider-field').filter({ hasText: 'Base URL' })
    const keyField = detail.locator('label.provider-field').filter({ hasText: 'API key' })
    assert.equal(await baseField.locator('input').inputValue(), RESET_OVERRIDE_BASE)
    assert.equal(await keyField.locator('input').inputValue(), '')
    assert.equal(
      await keyField.locator('input').getAttribute('placeholder'),
      'Set — type a new value to replace',
      'the override key must be shown as stored, never as a value',
    )
    assert.ok(
      (await detail.innerText()).includes(RESET_OVERRIDE_MODEL),
      'the override model must render before reset',
    )
    assert.ok(
      !(await page.content()).includes(RESET_OVERRIDE_SECRET),
      'the override API key leaked into the page',
    )

    const resetButton = detail.getByRole('button', { name: 'Reset to default', exact: true })
    await resetButton.waitFor({ state: 'visible' })
    const resetResponse = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url() === `${be.base}/api/providers/${RESET_SEED}/reset`,
    )
    await resetButton.click()

    const resetDialog = page.locator('.app-dialog').filter({
      has: page.locator('.provider-reset-confirm'),
    })
    await resetDialog.waitFor({ state: 'visible' })
    assert.equal(
      (await resetDialog.locator('.app-dialog__title').innerText()).trim(),
      `Reset ${RESET_SEED} to default?`,
    )
    assert.ok(
      (await resetDialog.locator('.app-dialog__description').innerText()).includes(
        'role assignments remain unchanged',
      ),
      'the confirmation must state that role assignments survive',
    )
    await resetDialog
      .locator('.app-dialog__footer')
      .getByRole('button', { name: 'Reset to default', exact: true })
      .click()

    const response = await resetResponse
    const resetBody = await response.json()
    assert.equal(response.status(), 200, `POST reset -> HTTP ${response.status()}`)
    assert.deepEqual(resetBody, { provider: RESET_PRISTINE })
    assert.ok(
      !JSON.stringify(resetBody).includes(RESET_OVERRIDE_SECRET),
      'the reset response echoed the old API key',
    )
    await resetDialog.waitFor({ state: 'hidden' })

    // -- pristine values/flags render, and the role assignments survive
    await waitFor(
      async () => (await detail.locator('.provider-kind-chip').innerText()).trim() === 'OpenAI-compatible',
      { desc: 'detail to show the pristine provider kind' },
    )
    assert.equal(await baseField.locator('input').inputValue(), RESET_PRISTINE.base_url)
    assert.equal(await keyField.locator('input').inputValue(), '')
    assert.equal(
      await keyField.locator('input').getAttribute('placeholder'),
      'Not set — paste a key to store one',
      'the pristine key state must replace the stored override state',
    )
    assert.equal(await row.locator('.provider-key-dot').getAttribute('aria-label'), 'API key missing')
    const pristineText = await detail.innerText()
    for (const model of RESET_PRISTINE.models) {
      assert.ok(pristineText.includes(model), `pristine model "${model}" missing after reset`)
    }
    assert.ok(
      !pristineText.includes(RESET_OVERRIDE_MODEL),
      'the customized model is still rendered after reset',
    )
    assert.equal(await detail.locator('.provider-badge.is-muted').count(), 0)
    assert.ok(
      !(await detail.locator('.provider-badge').allInnerTexts()).map((text) => text.trim()).includes('Customized'),
      'Customized badge must disappear after reset',
    )
    assert.deepEqual(
      await detail.locator('.provider-badge.is-role').allInnerTexts(),
      ['Used by Senior', 'Used by Junior'],
      'role assignments must survive the reset',
    )
    assert.deepEqual(
      await row.locator('.provider-role').allInnerTexts(),
      ['Senior', 'Junior'],
      'role badges must survive on the list row',
    )
    assert.equal(
      await detail.getByRole('button', { name: 'Reset to default', exact: true }).count(),
      0,
      'a pristine seed must not offer Reset to default',
    )
    await waitFor(async () => (await row.locator('.provider-row-tag').count()) === 0, {
      desc: 'Customized row tag to disappear',
    })
    await waitFor(
      async () => {
        const live = pane.locator('p[role="status"]')
        return (
          (await live.count()) > 0 &&
          (await live.first().innerText()).includes(`Reset ${RESET_SEED} to default`)
        )
      },
      { desc: 'reset announcement' },
    )

    // -- role cards keep the preset + model that pointed at the reset seed
    await settings.getByRole('button', { name: 'Models & roles', exact: true }).click()
    const rolesPane = settings.locator('[role="region"][aria-label="Models & roles"]')
    await rolesPane.waitFor({ state: 'visible' })
    for (const [role, model] of [
      ['senior', RESET_SENIOR_MODEL],
      ['junior', RESET_JUNIOR_MODEL],
    ]) {
      const card = rolesPane.locator(`.role-card--${role}`)
      assert.equal((await card.locator('.role-chip').innerText()).trim(), 'preset')
      const modelInput = card.locator('.n-form-item').filter({ hasText: 'Model' }).locator('input')
      assert.equal(await modelInput.inputValue(), model, `${role} model changed after reset`)
      const connectionText = (await card.locator('.n-base-selection').innerText()).trim()
      assert.ok(
        connectionText.includes(RESET_SEED),
        `${role} role no longer selects ${RESET_SEED} (got: ${connectionText})`,
      )
      assert.ok(
        connectionText.includes(RESET_PRISTINE.base_url),
        `${role} role did not pick up the pristine base URL (got: ${connectionText})`,
      )
    }

    // -- backend state + no secret exposure anywhere
    const providersNow = (await (await fetch(`${be.base}/api/providers`)).json()).providers
    assert.deepEqual(
      providersNow.find((provider) => provider.name === RESET_SEED),
      RESET_PRISTINE,
    )
    assert.deepEqual(
      providersNow.find((provider) => provider.name === RESET_UNRELATED_NAME),
      {
        name: RESET_UNRELATED_NAME,
        base_url: RESET_UNRELATED_BASE,
        api_key_set: true,
        kind: 'openai-compatible',
        models: ['unrelated-model'],
        seed: false,
        customized: true,
      },
      'reset must leave an unrelated custom provider untouched',
    )
    const settingsNow = await (await fetch(`${be.base}/api/settings`)).json()
    assert.equal(settingsNow.senior.provider_ref, RESET_SEED)
    assert.equal(settingsNow.junior.provider_ref, RESET_SEED)
    assert.equal(settingsNow.senior.model, RESET_SENIOR_MODEL)
    assert.equal(settingsNow.junior.model, RESET_JUNIOR_MODEL)
    for (const payload of [providersNow, settingsNow]) {
      const serialized = JSON.stringify(payload)
      for (const secret of [RESET_OVERRIDE_SECRET, RESET_UNRELATED_SECRET]) {
        assert.ok(!serialized.includes(secret), 'an API response exposed key material')
      }
    }
    assert.ok(!(await page.content()).includes(RESET_OVERRIDE_SECRET))
    assert.ok(!(await page.content()).includes(RESET_UNRELATED_SECRET))

    const onDisk = fs.readFileSync(path.join(be.dir, 'settings.json'), 'utf-8')
    for (const secret of [RESET_OVERRIDE_SECRET, RESET_UNRELATED_SECRET]) {
      assert.ok(!onDisk.includes(secret), 'settings.json contains plaintext key material')
    }
    const rawSettings = JSON.parse(onDisk)
    assert.equal(rawSettings.senior.provider_ref, RESET_SEED)
    assert.equal(rawSettings.junior.provider_ref, RESET_SEED)
    assert.ok(
      !rawSettings.providers.some(
        (provider) => provider.name.toLowerCase() === RESET_SEED.toLowerCase(),
      ),
      'reset must not persist the canonical seed as a stored override',
    )

    // a second reset is a stable 409: the seed is pristine server-side too
    const secondReset = await apiCall(be.base, 'POST', `/api/providers/${RESET_SEED}/reset`)
    assert.equal(secondReset.status, 409, `second reset -> HTTP ${secondReset.status}`)
    assert.deepEqual(secondReset.json, {
      detail: `provider is not customized: ${RESET_SEED}`,
    })

    await settings.getByRole('button', { name: 'Close settings' }).click()
    await settings.waitFor({ state: 'hidden' })

    consoleGuard.assertClean()
    runner.pass('provider-reset')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: step folding -----------------------------------------------------------
//
// Two work-mode runs whose junior writes two `todo_write` plans each: every run
// leaves two tool cards in the transcript. Once a run finishes it folds into one
// muted summary disclosure row; the run the page currently follows keeps its
// rows open (the fixture lingers before the second run's deliverable, so that
// window is deterministic). The summary is a real button with aria-expanded:
// expanding restores the rows in place, collapsing removes them from the DOM,
// and a session switch resets the expansion state.

async function scenarioFolding(runner) {
  const FIRST = 'E2E folding first task'
  const SECOND = 'E2E folding second task'
  const OTHER = 'E2E folding other session'
  const be = await startBackend({ kind: 'fixture', scenario: 'folding', lingerMs: 2500 })
  const { context, page, consoleGuard } = await newScenarioPage()
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    // no workspace: the work-mode run only has the plan tool, so no approval
    // prompt interrupts the scripted run
    await createSession(page, 'E2E folding session')

    // -- run 1: two tool cards; once completed they collapse into one summary
    await sendTask(page, FIRST, { mode: 'work' })
    await waitForRunEnd(page)
    const folds = page.locator('.fold-toggle')
    await waitFor(async () => (await folds.count()) === 1, {
      desc: 'the first completed run to fold its tool rows',
    })
    const firstFold = folds.first()
    assert.equal(await firstFold.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await page.locator('.tool-activity').count(),
      0,
      'a collapsed fold must remove its tool rows from the DOM',
    )
    const label = (await firstFold.locator('.fold-label').innerText()).trim()
    assert.equal(label, '2 tool calls', `fold summary label (got "${label}")`)
    assert.equal((await firstFold.locator('.fold-hint').innerText()).trim(), 'expand')
    assert.ok(
      (await page.locator('.chat-group.side-senior .bubble.bubble-highlight').count()) >= 1,
      'the decision bubble must stay visible next to a fold summary',
    )

    // -- run 2: the followed run's tool rows stay open while it works
    await sendTask(page, SECOND, { mode: 'work' })
    await waitFor(async () => (await page.locator('.tool-activity').count()) === 2, {
      desc: 'the followed run tool rows to stay open',
    })
    assert.equal(
      await folds.count(),
      1,
      'the earlier completed run must stay folded while the next run is followed',
    )
    const openTools = (await page.locator('.tool-activity .tool-name').allInnerTexts()).map((t) =>
      t.trim(),
    )
    assert.deepEqual(openTools, ['todo_write', 'todo_write'])
    const foldBox = await firstFold.boundingBox()
    const openBox = await page.locator('.tool-activity').first().boundingBox()
    assert.ok(
      foldBox && openBox && foldBox.y < openBox.y,
      'the fold summary must sit before the followed run rows',
    )
    await waitForRunEnd(page)
    // Every completed-run tool card must leave the DOM again. Depending on how
    // the runs' whole-second envelope timestamps line up this can form one fold
    // group per run (two rows) or one merged group (four tool calls), so account
    // for both shapes honestly instead of pinning a fragile count.
    await waitFor(async () => (await page.locator('.tool-activity').count()) === 0, {
      desc: 'all completed-run tool cards to fold',
    })
    const labels = (await folds.locator('.fold-label').allInnerTexts()).map((t) => t.trim())
    assert.ok(labels.length >= 1 && labels.length <= 2, `unexpected fold count: ${labels.join(' | ')}`)
    const foldCalls = labels.reduce((sum, label) => sum + (Number.parseInt(label, 10) || 0), 0)
    assert.equal(
      foldCalls,
      4,
      `the fold summaries must account for all four completed tool cards (${labels.join(' | ')})`,
    )

    // -- expanding restores the older rows in place; collapsing removes them
    const firstCount = Number.parseInt(labels[0], 10)
    await firstFold.click()
    assert.equal(await firstFold.getAttribute('aria-expanded'), 'true')
    assert.equal((await firstFold.locator('.fold-hint').innerText()).trim(), 'collapse')
    await waitFor(async () => (await page.locator('.tool-activity').count()) === firstCount, {
      desc: 'the expanded run rows to render',
    })
    const expandedTools = (await page.locator('.tool-activity .tool-name').allInnerTexts()).map((t) =>
      t.trim(),
    )
    assert.equal(expandedTools.length, firstCount)
    assert.ok(
      expandedTools.every((name) => name === 'todo_write'),
      `unexpected expanded tool names: ${expandedTools.join(', ')}`,
    )
    await firstFold.click()
    assert.equal(await firstFold.getAttribute('aria-expanded'), 'false')
    await waitFor(async () => (await page.locator('.tool-activity').count()) === 0, {
      desc: 'collapsing to remove the rows from the DOM again',
    })
    assert.equal(await folds.count(), labels.length)

    // -- fold state is per session: switching away and back starts collapsed
    await createSession(page, OTHER)
    await page.locator('.chat-scroll').waitFor({ state: 'visible' })
    assert.equal(await page.locator('.fold-toggle').count(), 0, 'another session has no folds')
    await page.locator('.session-item', { hasText: 'E2E folding session' }).first().click()
    await waitFor(async () => (await page.locator('.fold-toggle').count()) >= 1, {
      desc: 'the original session folds to come back',
    })
    await waitFor(async () => (await page.locator('.tool-activity').count()) === 0, {
      desc: 'the restored session rows to start collapsed',
    })
    const states = await page
      .locator('.fold-toggle')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')))
    assert.ok(states.length >= 1)
    assert.ok(
      states.every((state) => state === 'false'),
      `a session switch must reset expansion state (got ${states.join(', ')})`,
    )

    consoleGuard.assertClean()
    runner.pass('folding')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: plan dock --------------------------------------------------------------
//
// Three work-mode runs (no workspace needed: the plan tool never needs one):
// run 1 writes a three-item plan (one ✓, one ▸, one ○), run 2 replaces it with a
// six-item plan that exceeds the bounded list (the "+N more" expand control
// reveals the rest), run 3 clears it. The dock's counts, markers, item texts and
// polite live-region announcements are asserted after each run.

const PLAN_TICK = '\u2713'
const PLAN_ACTIVE = '\u25b8'
const PLAN_PENDING = '\u25cb'
const MIDDLE_DOT = '\u00b7'

async function scenarioPlanDock(runner) {
  const be = await startBackend({ kind: 'fixture', scenario: 'plan' })
  const { context, page, consoleGuard } = await newScenarioPage()
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    await createSession(page, 'E2E plan session')
    const panel = page.locator('section.todo-panel')
    const counts = panel.locator('.todo-panel-counts')
    const rows = panel.locator('.todo-panel-row')
    const expand = panel.locator('.todo-panel-expand')

    // -- run 1: a three-item plan, shown whole (under the collapsed bound)
    await sendTask(page, 'E2E plan first task', { mode: 'work' })
    await waitForRunEnd(page)
    await panel.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await panel.getAttribute('aria-label'), 'Plan')
    // textContent, not innerText: the title is CSS `text-transform: uppercase`,
    // and Chromium's innerText returns the transformed "PLAN".
    const planTitle = (
      await panel.locator('.todo-panel-title').evaluate((el) => el.textContent ?? '')
    ).trim()
    assert.equal(planTitle, 'Plan')
    assert.equal((await counts.innerText()).trim(), `1/3 done ${MIDDLE_DOT} 1 in progress`)
    assert.equal(await rows.count(), 3)
    assert.equal(await panel.locator('.todo-panel-row-completed').count(), 1)
    assert.equal(await panel.locator('.todo-panel-row-in_progress').count(), 1)
    assert.equal(await panel.locator('.todo-panel-row-pending').count(), 1)
    assert.deepEqual(
      (await panel.locator('.todo-panel-marker').allInnerTexts()).map((t) => t.trim()),
      [PLAN_TICK, PLAN_ACTIVE, PLAN_PENDING],
    )
    assert.deepEqual(
      (await panel.locator('.todo-panel-content').allInnerTexts()).map((t) => t.trim()),
      ['Inspect the workspace', 'Draft the migration plan', 'Verify the plan'],
    )
    assert.equal(await expand.count(), 0, 'a plan that fits needs no expand control')

    // -- run 2: a six-item plan -> bounded list + honest "+N more" expand
    await sendTask(page, 'E2E plan second task', { mode: 'work' })
    await waitForRunEnd(page)
    await waitFor(
      async () =>
        (await counts.innerText()).trim() === `2/6 done ${MIDDLE_DOT} 1 in progress`,
      { desc: 'the six-item plan snapshot header' },
    )
    assert.equal(await rows.count(), 4, 'the collapsed plan shows the bounded four rows')
    assert.equal(await expand.getAttribute('aria-expanded'), 'false')
    assert.match((await expand.innerText()).trim(), /^\+2 more/)
    await expand.click()
    assert.equal(await expand.getAttribute('aria-expanded'), 'true')
    await waitFor(async () => (await rows.count()) === 6, {
      desc: 'expanding to reveal the complete plan',
    })
    assert.equal(await panel.locator('.todo-panel-row-completed').count(), 2)
    assert.equal((await expand.innerText()).trim(), 'Show less')
    await expand.click()
    assert.equal(await expand.getAttribute('aria-expanded'), 'false')
    await waitFor(async () => (await rows.count()) === 4, {
      desc: 'collapsing back to the bounded plan rows',
    })
    // a plan change is announced politely (the dock's persistent live region)
    const updated = page.locator('p[role="status"]', { hasText: 'Plan updated: 2 of 6 done' })
    await updated.first().waitFor({ timeout: 10000 })

    // -- run 3: the model clears the plan -> dock gone + "Plan cleared."
    await sendTask(page, 'E2E plan third task', { mode: 'work' })
    await waitForRunEnd(page)
    await waitFor(async () => (await panel.count()) === 0, {
      desc: 'the plan dock to disappear when the model clears the plan',
    })
    const cleared = page.locator('p[role="status"]', { hasText: 'Plan cleared.' })
    await cleared.first().waitFor({ timeout: 10000 })

    consoleGuard.assertClean()
    runner.pass('plan-dock')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: composer status seats ---------------------------------------------------
//
// Role models are written through the settings API before the page loads, so the
// composer seats can show real names; a mock-provider run then supplies the
// latest prompt audit the context seat reports (character counts and offered
// tools only — no tokenizer, no invented token counts).

async function scenarioComposerSeats(runner) {
  const SEAT_SENIOR = 'seat-senior-model'
  const SEAT_JUNIOR = 'seat-junior-model'
  const be = await startBackend({ kind: 'mock' })
  const wsDir = tmpDir('tb-e2e-ws-seats')
  const wsName = path.basename(wsDir)
  const { context, page, consoleGuard } = await newScenarioPage()
  try {
    const put = await apiCall(be.base, 'PUT', '/api/settings', {
      senior: { model: SEAT_SENIOR, base_url: 'http://127.0.0.1:9/v1' },
      junior: { model: SEAT_JUNIOR, base_url: 'http://127.0.0.1:9/v1' },
    })
    assert.equal(put.status, 200, `PUT /api/settings -> HTTP ${put.status}`)

    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, 'E2E seats session')

    const seats = page.locator('.composer-seats')
    await seats.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await seats.getAttribute('aria-label'), 'Run status')
    const models = seats.locator('.composer-seat.is-models')
    const permission = seats.locator('.composer-seat.is-permissions')
    const contextSeat = seats.locator('.composer-seat.is-context')
    const modelsText = (await models.innerText()).replace(/\s+/g, ' ').trim()
    assert.ok(modelsText.includes(`S ${SEAT_SENIOR}`), `senior model missing from seats: ${modelsText}`)
    assert.ok(modelsText.includes(`J ${SEAT_JUNIOR}`), `junior model missing from seats: ${modelsText}`)
    assert.equal(
      (await permission.innerText()).replace(/\s+/g, ' ').trim(),
      'Permissions Ask in app',
    )
    // no audited provider call yet: the context seat has no data and must hide
    assert.equal(await contextSeat.count(), 0, 'the context seat must hide without an audit')

    // -- one mock-provider run (every provider call is audited)
    await sendTask(page, 'Explain a reversible migration')
    await waitForRunEnd(page)
    await waitFor(async () => (await contextSeat.count()) === 1, {
      desc: 'the context seat after an audited run',
    })
    const seatText = (await contextSeat.innerText()).replace(/\s+/g, ' ').trim()
    assert.match(
      seatText,
      /^Context [\d.]+k? system [\u00b7] [\d.]+k? context [\u00b7] \d+ tools$/,
      `unexpected context seat text: ${seatText}`,
    )
    // truth: the seat's title must match the latest audit the backend recorded
    const sessionName = await sessionNameByTitle(be.base, 'E2E seats session')
    const runtime = await (await fetch(
      `${be.base}/api/sessions/${encodeURIComponent(sessionName)}/events`,
    )).json()
    const audits = (runtime.events ?? []).filter((event) => event.type === 'prompt_audit')
    assert.ok(audits.length > 0, 'the mock run emitted no prompt audit')
    const latest = audits[audits.length - 1]
    const title = await contextSeat.getAttribute('title')
    assert.ok(
      title.includes(`${latest.systemChars.toLocaleString('en-US')} system-prompt characters`),
      `context seat title does not carry the audit's system chars: ${title}`,
    )
    assert.ok(
      title.includes(`${latest.userChars.toLocaleString('en-US')} context characters`),
      `context seat title does not carry the audit's context chars: ${title}`,
    )
    assert.ok(
      title.includes(`${latest.tools.length} tools offered`),
      `context seat title does not carry the audit's tool count: ${title}`,
    )
    // no fabricated token accounting anywhere in the seats
    const seatTitles = (
      await seats
        .locator('.composer-seat')
        .evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
    ).join(' ')
    assert.ok(
      !/\btokens?\b/i.test(`${await seats.innerText()} ${seatTitles}`),
      'the seats must not invent token counts',
    )

    // -- a fresh session without any audit: the data seat disappears again
    await createSession(page, 'E2E seats empty session')
    await waitFor(async () => (await contextSeat.count()) === 0, {
      desc: 'the context seat to hide again for a session without audit data',
    })
    await seats.waitFor({ state: 'visible' })

    consoleGuard.assertClean()
    runner.pass('composer-seats')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: welcome hero + starters -------------------------------------------------
//
// No session selected: the landing hero. An empty selected session: the
// empty-transcript hero (inside the transcript area, replacing the bare hint).
// Starters only *draft* text into the composer; an occupied composer keeps its
// draft and shows an honest notice instead.

async function scenarioHeroStarters(runner) {
  const be = await startBackend({ kind: 'mock' })
  const wsDir = tmpDir('tb-e2e-ws-hero')
  const wsName = path.basename(wsDir)
  const { context, page, consoleGuard } = await newScenarioPage()
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    const hero = page.locator('.welcome-hero')
    const title = hero.locator('#welcome-hero-title')
    const chip = hero.locator('.welcome-hero-chip')
    const textarea = page.locator('textarea.composer-input')

    // -- landing state: the start hero replaces the old static card
    await hero.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal((await title.innerText()).trim(), 'Two Brothers workspace')
    assert.equal(await hero.locator('.welcome-hero-starter').count(), 3)
    assert.match((await chip.innerText()).trim(), /No workspace linked yet/)
    assert.equal(
      await page.locator('.chat-scroll .empty-hint').count(),
      0,
      'the hero must replace the bare empty placeholder',
    )
    assert.equal(await hero.getByRole('button', { name: 'New session', exact: true }).count(), 1)
    assert.equal(await hero.getByRole('button', { name: 'Add a workspace', exact: true }).count(), 1)

    // -- workspace context: adding + filtering a workspace names it in the chip
    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await waitFor(async () => (await chip.innerText()).includes(wsName), {
      desc: 'the hero workspace chip to name the selected workspace',
    })

    // -- empty selected session: the empty-transcript hero variant
    await createSession(page, 'E2E hero session')
    await hero.waitFor({ state: 'visible' })
    assert.equal((await title.innerText()).trim(), 'This session is empty')
    assert.ok((await chip.innerText()).includes(wsName))
    assert.equal((await hero.locator('.welcome-hero-meta').innerText()).trim(), 'E2E hero session')
    assert.equal(await page.locator('.chat-scroll .empty-hint').count(), 0)
    assert.equal(await textarea.inputValue(), '')

    // -- a starter drafts into an EMPTY composer (editable, nothing sent)
    const starters = hero.locator('.welcome-hero-starter')
    assert.equal((await starters.first().locator('.starter-label').innerText()).trim(), 'Plan a change')
    await starters.first().click()
    await waitFor(async () => (await textarea.inputValue()) === '/plan ', {
      desc: 'the starter to prefill the composer',
    })
    await waitFor(async () => (await page.evaluate(() => document.activeElement?.id ?? '')) === 'composer-input', {
      desc: 'the starter to focus the task box so the draft is editable',
    })
    assert.equal(
      (await (await fetch(`${be.base}/api/runs`)).json()).length,
      0,
      'a starter must not start a run',
    )

    // -- an existing draft is never overwritten; the honest notice explains
    await textarea.fill('my own draft')
    await starters.nth(1).click()
    assert.equal(await textarea.inputValue(), 'my own draft')
    const notice = page.locator('.command-notice')
    await notice.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(
      (await notice.locator('.command-notice-text').innerText()).trim(),
      /already has a draft/,
    )
    assert.equal(await notice.getAttribute('role'), 'status')
    assert.equal(await notice.getAttribute('aria-live'), 'polite')
    assert.equal(
      (await (await fetch(`${be.base}/api/runs`)).json()).length,
      0,
      'the blocked starter must not start a run',
    )

    consoleGuard.assertClean()
    runner.pass('hero-starters')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: composer recall (Up/Down) ------------------------------------------------
//
// The composer's prompt recall (web/src/recall.ts + Composer.vue) has pure unit
// tests; this drives the real UI. Two accepted submissions become the history
// (newest first); ArrowUp recalls them while an unsent draft is stashed and
// restored byte-exactly, a multiline draft only leaves the composer at its
// absolute start (caret movement everywhere else), recall navigation never
// submits a run or opens the `/` picker, and the versioned localStorage history
// survives a page reload.

async function scenarioComposerRecall(runner) {
  const FIRST_TASK = 'e2e recall first task'
  const SECOND_TASK = 'e2e recall second task'
  const UNSENT_DRAFT = 'draft that must stay unsent'
  const MULTILINE_DRAFT = 'line one\nline two'
  const be = await startBackend({ kind: 'mock' })
  const { context, page, consoleGuard } = await newScenarioPage()
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    await createSession(page, 'E2E recall session')
    const textarea = page.locator('textarea.composer-input')
    // one `.bubble` per operator message (a speaker group may merge several)
    const operatorBubbles = page.locator('.chat-group.side-operator .bubble')

    /** Focus the composer with a collapsed caret at a number / 'start' / 'end'. */
    const caretTo = (at) =>
      textarea.evaluate((el, position) => {
        el.focus()
        const offset =
          position === 'start' ? 0 : position === 'end' ? el.value.length : position
        el.setSelectionRange(offset, offset)
      }, at)

    // -- two accepted submissions become the recall history (newest first)
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])
    const waitRunsDone = async (count) => {
      await waitFor(
        async () => {
          const runs = await (await fetch(`${be.base}/api/runs`)).json()
          return runs.length === count && runs.every((run) => terminalStatuses.has(run.status))
        },
        { timeout: 90000, desc: `${count} accepted run(s) to reach a terminal state` },
      )
    }
    for (const [index, task] of [FIRST_TASK, SECOND_TASK].entries()) {
      await sendTask(page, task)
      // deterministic backend truth first: both runs really finished before the
      // next submission, so the recall history order can never depend on timing
      await waitRunsDone(index + 1)
      await waitForRunEnd(page)
      // the operator block renders from the persisted envelopes after run end
      await waitFor(async () => (await operatorBubbles.count()) === index + 1, {
        desc: `submitted task ${index + 1} to render`,
      })
    }
    const runsBefore = await (await fetch(`${be.base}/api/runs`)).json()
    assert.equal(runsBefore.length, 2, `expected two accepted runs, got ${runsBefore.length}`)

    // the persisted store itself: versioned key, versioned document, newest first
    const recallBlob = await page.evaluate(() =>
      window.localStorage.getItem('two-brothers.composerHistory.v1'),
    )
    assert.ok(recallBlob, 'accepted submissions were not persisted to the recall store')
    const recallDoc = JSON.parse(recallBlob)
    assert.equal(recallDoc.version, 1, 'the recall store must be versioned')
    assert.deepEqual(
      recallDoc.entries,
      [SECOND_TASK, FIRST_TASK],
      'the recall store must be newest-first and hold exactly the accepted tasks',
    )

    // -- single-line draft: Up recalls newest, Up again older; Down walks
    //    forward again and the final Down restores the draft byte-exactly
    await textarea.fill(UNSENT_DRAFT)
    await caretTo('end')
    await page.keyboard.press('ArrowUp')
    await waitFor(async () => (await textarea.inputValue()) === SECOND_TASK, {
      desc: 'ArrowUp to recall the newest accepted task',
    })
    await page.keyboard.press('ArrowUp')
    await waitFor(async () => (await textarea.inputValue()) === FIRST_TASK, {
      desc: 'ArrowUp to recall the older accepted task',
    })
    await page.keyboard.press('ArrowDown')
    await waitFor(async () => (await textarea.inputValue()) === SECOND_TASK, {
      desc: 'ArrowDown to walk forward to the newest task',
    })
    await page.keyboard.press('ArrowDown')
    await waitFor(async () => (await textarea.inputValue()) === UNSENT_DRAFT, {
      desc: 'ArrowDown past the newest entry to restore the unsent draft',
    })

    // -- multiline drafts: Up is caret movement everywhere except the very start
    //    (real key path: Shift+Enter inserts the newline, not fill())
    await textarea.fill('')
    await textarea.focus()
    await page.keyboard.type('line one')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('line two')
    await waitFor(async () => (await textarea.inputValue()) === MULTILINE_DRAFT, {
      desc: 'Shift+Enter to build a two-line draft',
    })
    await caretTo('end')
    await page.keyboard.press('ArrowUp')
    await sleep(200)
    assert.equal(
      await textarea.inputValue(),
      MULTILINE_DRAFT,
      'ArrowUp at the end of a multiline draft must move the caret, not recall',
    )
    await caretTo(3) // inside the first line
    await page.keyboard.press('ArrowUp')
    await sleep(200)
    assert.equal(
      await textarea.inputValue(),
      MULTILINE_DRAFT,
      'ArrowUp inside a multiline draft must never recall',
    )
    await caretTo('start')
    await page.keyboard.press('ArrowUp')
    await waitFor(async () => (await textarea.inputValue()) === SECOND_TASK, {
      desc: 'ArrowUp at the absolute start of a multiline draft to recall',
    })
    await page.keyboard.press('ArrowDown')
    await waitFor(async () => (await textarea.inputValue()) === MULTILINE_DRAFT, {
      desc: 'ArrowDown to restore the multiline draft exactly',
    })

    // -- navigation is not a submission: no run, no operator block, no picker
    const runsAfter = await (await fetch(`${be.base}/api/runs`)).json()
    assert.equal(runsAfter.length, runsBefore.length, 'recall navigation must never submit a run')
    assert.equal(
      await operatorBubbles.count(),
      2,
      'recall navigation must not add or remove operator task messages',
    )
    assert.equal(
      await textarea.getAttribute('aria-expanded'),
      'false',
      'recall navigation must leave the mention picker collapsed',
    )
    assert.equal(await page.locator('.mention-picker').count(), 0, 'the mention picker stays closed')
    assert.equal(await textarea.isEnabled(), true, 'the composer must stay enabled during recall')
    // the drafts that were only ever recall stashes never reached the transcript
    const transcript = await page.locator('.chat-scroll').innerText()
    assert.ok(transcript.includes(FIRST_TASK), 'the first submitted task is in the transcript')
    assert.ok(transcript.includes(SECOND_TASK), 'the second submitted task is in the transcript')
    assert.ok(
      !transcript.includes(UNSENT_DRAFT) && !transcript.includes(MULTILINE_DRAFT),
      'a recalled or stashed draft must never become a submitted task',
    )

    // -- the history is persisted (versioned localStorage): a reload keeps the
    //    accepted tasks recallable
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    const sessionItem = page.locator('.session-item', { hasText: 'E2E recall session' }).first()
    await sessionItem.waitFor({ timeout: 10000 })
    await sessionItem.click()
    await waitFor(async () => (await operatorBubbles.count()) === 2, {
      desc: 'the recalled session transcript after a reload',
    })
    await textarea.fill('')
    await caretTo('end')
    await page.keyboard.press('ArrowUp')
    await waitFor(async () => (await textarea.inputValue()) === SECOND_TASK, {
      desc: 'the persisted recall history to survive a reload',
    })

    consoleGuard.assertClean()
    runner.pass('composer-recall')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: approval reason + preview ------------------------------------------------
//
// A delete approval carries the product's documented DELETE_APPROVAL_REASON:
// the pending card renders it verbatim (the backend emits the additive `reason`
// field on `approval_requested`), the resolved history card keeps the same text
// (the request reason survives Allow/Deny), the allow path removes the file, and
// no raw protocol marker leaks into the transcript.
//
// The same pending card carries the additive bounded preview (`detail`): its
// toggle is a real button (aria-expanded / aria-controls) that expands the
// unified diff as a plain-text <pre> and collapses it again. The deleted file's
// content contains literal HTML, which must survive as TEXT (no injection).

async function scenarioApprovalReason(runner) {
  const DELETE_FILE = 'e2e-approval-reason.txt'
  // Literal markup proves the preview is text-only: if it were parsed as HTML
  // an <img>/handler would appear in the DOM and the console guard would see it.
  const DELETE_CONTENT =
    'created by the E2E approval-reason scenario <img src=x onerror="window.__e2e_pwned=1">\n'
  const DELETE_REASON =
    'permanently removes the file from the workspace \u2014 deletion cannot be undone'
  const be = await startBackend({ kind: 'fixture', scenario: 'delete' })
  const wsDir = tmpDir('tb-e2e-ws-reason')
  const wsName = path.basename(wsDir)
  const deletePath = path.join(wsDir, DELETE_FILE)
  const { context, page, consoleGuard } = await newScenarioPage()
  try {
    // the target exists before the run, so the delete has something to remove
    fs.writeFileSync(deletePath, DELETE_CONTENT)
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, 'E2E approval reason session')

    await sendTask(page, `Delete ${DELETE_FILE} from the workspace`, { mode: 'work' })
    const dock = page.locator('.approval-dock')
    await dock.waitFor({ state: 'visible', timeout: 30000 })
    const card = dock.locator('article.approval')
    await card.waitFor({ state: 'visible' })
    // the documented reason text, rendered verbatim on the pending card
    const reason = card.locator('.approval-reason')
    await reason.waitFor({ state: 'visible' })
    assert.equal((await reason.innerText()).trim(), DELETE_REASON)
    // The card renders the normalized action label ("delete"), not the tool name,
    // plus the workspace-relative target.
    const bodyText = (await card.locator('.approval-body').innerText()).replace(/\s+/g, ' ').trim()
    assert.match(
      bodyText,
      /^action delete target e2e-approval-reason\.txt$/i,
      `unexpected approval card body: ${bodyText}`,
    )
    // the pending timeline duplicate stays suppressed in favour of the dock
    assert.equal(await page.locator('article.approval', { hasText: 'awaiting you' }).count(), 1)

    // -- additive approval preview: a real toggle + a plain-text <pre> ----------
    // Collapsed by default; the toggle owns aria-expanded and points at the
    // <pre> it controls; expanding shows the diff as text, collapsing hides it.
    const previewToggle = card.locator('button.approval-preview-toggle')
    await previewToggle.waitFor({ state: 'visible' })
    const previewLabel = previewToggle.locator('.approval-preview-label')
    assert.equal(
      await previewToggle.getAttribute('aria-expanded'),
      'false',
      'the preview starts collapsed',
    )
    assert.equal((await previewLabel.innerText()).trim(), 'Preview the change')
    assert.equal(
      (await previewToggle.locator('.approval-preview-counts').innerText()).trim(),
      '+0 -1',
      'a removed-only diff reports +0 -1',
    )
    const previewId = await previewToggle.getAttribute('aria-controls')
    assert.ok(
      previewId !== null && /^approval-preview-[A-Za-z0-9_-]+$/.test(previewId),
      `the toggle must control a stable preview id (got ${previewId})`,
    )
    const preview = card.locator(`#${previewId}`)
    assert.equal(await preview.count(), 1, 'the controlled preview body must exist')
    assert.equal(await preview.isVisible(), false, 'a collapsed preview body is hidden')
    assert.ok(
      ((await preview.textContent()) ?? '').includes(
        '-created by the E2E approval-reason scenario <img src=x',
      ),
      'the collapsed body already carries the diff text',
    )

    await previewToggle.click()
    assert.equal(await previewToggle.getAttribute('aria-expanded'), 'true')
    assert.equal((await previewLabel.innerText()).trim(), 'Hide preview')
    await preview.waitFor({ state: 'visible' })
    const previewText = await preview.innerText()
    assert.ok(previewText.includes('--- a/e2e-approval-reason.txt'), `missing diff header: ${previewText}`)
    assert.ok(previewText.includes('+++ b/e2e-approval-reason.txt'), 'missing diff header')
    assert.ok(
      previewText.includes(
        '-created by the E2E approval-reason scenario <img src=x onerror="window.__e2e_pwned=1">',
      ),
      'the removed line must render as text',
    )
    // The diff is interpolated into the <pre> as text (Vue escapes text nodes):
    // the markup stays literal, no node is created and no handler can run.
    const previewHtml = await preview.evaluate((el) => el.innerHTML)
    assert.ok(previewHtml.includes('&lt;img src=x'), 'the diff must be escaped text, not markup')
    assert.equal(await preview.locator('img').count(), 0, 'diff markup must never become a DOM node')
    assert.equal(
      await page.evaluate(() => window.__e2e_pwned ?? null),
      null,
      'no injected handler may run',
    )

    await previewToggle.click()
    assert.equal(await previewToggle.getAttribute('aria-expanded'), 'false')
    assert.equal((await previewLabel.innerText()).trim(), 'Preview the change')
    await preview.waitFor({ state: 'hidden' })

    await dock.locator('button.approval-btn', { hasText: 'Allow once' }).click()
    await waitForRunEnd(page)
    assert.equal(fs.existsSync(deletePath), false, 'the approved delete did not remove the file')
    // The resolved history card keeps the allowed state AND the same verbatim
    // reason text the operator approved (the request reason survives Allow/Deny;
    // a cancellation reason wins when one is present).
    await waitFor(
      async () =>
        (await page.locator('article.approval .approval-status.approval-allowed').count()) >= 1,
      { desc: 'the resolved (allowed) approval card in history' },
    )
    const note = page.locator('article.approval .approval-note')
    await note.first().waitFor({ state: 'visible', timeout: 10000 })
    assert.equal((await note.first().innerText()).trim(), DELETE_REASON)
    // A resolved card no longer needs the pending-only preview surface.
    assert.equal(
      await page.locator('article.approval .approval-preview').count(),
      0,
      'the resolved history card drops the pending-only preview',
    )

    // no raw protocol marker or JSON leaks into the visible transcript
    const transcript = await page.locator('.chat-scroll').innerText()
    assert.ok(!transcript.includes('{"v":1'), 'raw protocol JSON visible in chat')
    assert.ok(!transcript.includes('[[TASK]]'), 'raw [[TASK]] marker visible in chat')
    assert.ok(
      !transcript.includes('[[REPAIR_REQUEST]]'),
      'raw [[REPAIR_REQUEST]] marker visible in chat',
    )

    consoleGuard.assertClean()
    runner.pass('approval-reason')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: real models (opt-in) ---------------------------------------------------

async function scenarioReal(runner) {
  const models = await probeLmStudio()
  if (!models.has(SENIOR_MODEL) || !models.has(JUNIOR_MODEL)) {
    throw new SkipError(
      `LM Studio ${LMSTUDIO_BASE} does not list both models (${SENIOR_MODEL}, ${JUNIOR_MODEL})`,
    )
  }

  const be = await startPlainBackend()
  const wsDir = tmpDir('tb-e2e-ws-real')
  const wsName = path.basename(wsDir)
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleGuard = attachConsoleGuard(page)
  try {
    // per-role provider/model -> LM Studio (OpenAI-compatible, no api_key needed)
    const put = await fetch(`${be.base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        senior: { provider: 'openai', base_url: LMSTUDIO_BASE, model: SENIOR_MODEL },
        junior: { provider: 'openai', base_url: LMSTUDIO_BASE, model: JUNIOR_MODEL },
      }),
    })
    assert.ok(put.ok, `PUT /api/settings -> HTTP ${put.status}`)

    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, 'E2E real session')

    // the run must take its models from the settings above (provider: null —
    // the composer no longer offers a provider override)
    const t0 = Date.now()
    await sendTask(page, REAL_TASK)

    // the UI POSTs the run; find its id, then follow the event stream ourselves
    const runId = await waitFor(
      async () => {
        const runs = await (await fetch(`${be.base}/api/runs`)).json()
        return runs.length ? runs[0].run_id : null
      },
      { timeout: 15000, desc: 'run record to appear' },
    )
    const events = await followRunEvents(be.base, runId, REAL_DEADLINE_MS)
    const elapsed = Date.now() - t0

    // (b) the stream must close with a completed run
    const end = events.find((e) => e.type === 'run_end')
    assert.ok(end, 'no run_end event on the SSE stream')
    assert.equal(end.status, 'completed', `run_end status: ${end.status}`)

    // (a) the consult cycle envelopes: operator task + senior consult +
    // junior proposal + senior review (+ revision rounds) + senior decision
    const envs = events.filter((e) => e.type === 'envelope').map((e) => e.envelope)
    const kinds = new Set(envs.map((e) => e.kind))
    for (const k of ['consult', 'proposal', 'review', 'decision']) {
      assert.ok(kinds.has(k), `envelope kind "${k}" missing (got: ${[...kinds].join(', ')})`)
    }
    assert.ok(envs.length >= 5, `expected at least 5 envelopes, got ${envs.length}`)

    // UI renders the same chat groups as the mock scenario
    await waitForRunEnd(page)
    const decision = page.locator('.chat-group.side-senior .bubble.bubble-highlight')
    await decision.waitFor({ timeout: 30000 })
    const speakers = new Set(await page.locator('.chat-group .speaker-name').allInnerTexts())
    for (const who of ['You', 'Senior', 'Junior']) {
      assert.ok(speakers.has(who), `speaker "${who}" missing (got: ${[...speakers].join(', ')})`)
    }
    assert.equal(await decision.count(), 1, 'expected exactly one highlighted senior decision')
    assert.equal(
      (await decision.locator('.kind-chip').innerText()).trim().toLowerCase(),
      'decision',
    )
    const transcript = await page.locator('.chat-scroll').innerText()
    assert.ok(!transcript.includes('{"v":1'), 'raw protocol JSON visible in chat')
    assert.ok(!transcript.includes('[[TASK]]'), 'raw [[TASK]] marker visible in chat')

    // (c) the run record carries a numeric usage object
    const run = await (await fetch(`${be.base}/api/runs/${runId}`)).json()
    assert.equal(run.status, 'completed', `run record status: ${run.status}`)
    assert.ok(
      run.usage && typeof run.usage === 'object',
      `run record has no usage object (expected keys: model_calls, input_tokens, ` +
        `output_tokens, cached_tokens) — got keys: ${JSON.stringify(Object.keys(run))}`,
    )
    for (const key of ['model_calls', 'input_tokens', 'output_tokens', 'cached_tokens']) {
      const v = run.usage[key]
      assert.ok(
        typeof v === 'number' && Number.isFinite(v),
        `usage.${key} is not numeric (got ${JSON.stringify(v)})`,
      )
    }

    // (d) wall time stayed under the deadline
    assert.ok(
      elapsed < REAL_DEADLINE_MS,
      `run took ${(elapsed / 1000).toFixed(1)}s, deadline is ${REAL_DEADLINE_MS / 60000} min`,
    )

    // (e) the app's browser console stayed clean for the whole run
    consoleGuard.assertClean()

    runner.pass('real')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- runner -----------------------------------------------------------------------------

function makeRunner(blockName) {
  return {
    current: blockName,
    pass(name) {
      this.current = name
      results.push({ name, status: 'PASS', secs: pendingSecs() })
    },
  }
}
let blockStart = Date.now()
let currentRunner = null
function pendingSecs() {
  return ((Date.now() - blockStart) / 1000).toFixed(1)
}

async function main() {
  const t0 = Date.now()
  await ensureWebBuild()
  ensureFreshPackagedWeb()
  await launchBrowser()
  log(`browser: ${browserLabel}`)
  log('backend: TypeScript server (packages/harness/dist/cli.js serve)')
  if (ONLY_SCENARIO) log(`scenario filter: ${ONLY_SCENARIO}`)

  const realEnabled = process.env.TWO_BROTHERS_REAL_E2E === '1'

  // Every scenario runs against the TypeScript backend. The fixture-driven
  // ones drive the built-in openai provider against the Node scripted model
  // server (fixtures/scripted-server.mjs, always present).
  const blocks = []
  if (tsAvailable) {
    const hermetic = [
      {
        label: 'chat/resume',
        run: () => (
          (currentRunner = makeRunner('chat')),
          scenarioChat(currentRunner)
        ),
      },
      {
        label: 'approval-allow',
        run: () => (
          (currentRunner = makeRunner('approval-allow')),
          approvalFlow(currentRunner, 'allow')
        ),
      },
      {
        label: 'approval-deny',
        run: () => (
          (currentRunner = makeRunner('approval-deny')),
          approvalFlow(currentRunner, 'deny')
        ),
      },
      {
        label: 'stop',
        run: () => (
          (currentRunner = makeRunner('stop')),
          scenarioStop(currentRunner)
        ),
      },
      {
        label: 'mobile',
        run: () => (
          (currentRunner = makeRunner('mobile')),
          scenarioMobile(currentRunner)
        ),
      },
      {
        label: 'appearance-density',
        run: () => (
          (currentRunner = makeRunner('appearance-density')),
          scenarioAppearanceDensity(currentRunner)
        ),
      },
      {
        label: 'provider-reset',
        run: () => (
          (currentRunner = makeRunner('provider-reset')),
          scenarioProviderReset(currentRunner)
        ),
      },
      {
        label: 'folding',
        run: () => (
          (currentRunner = makeRunner('folding')),
          scenarioFolding(currentRunner)
        ),
      },
      {
        label: 'plan-dock',
        run: () => (
          (currentRunner = makeRunner('plan-dock')),
          scenarioPlanDock(currentRunner)
        ),
      },
      {
        label: 'composer-seats',
        run: () => (
          (currentRunner = makeRunner('composer-seats')),
          scenarioComposerSeats(currentRunner)
        ),
      },
      {
        label: 'hero-starters',
        run: () => (
          (currentRunner = makeRunner('hero-starters')),
          scenarioHeroStarters(currentRunner)
        ),
      },
      {
        label: 'composer-recall',
        run: () => (
          (currentRunner = makeRunner('composer-recall')),
          scenarioComposerRecall(currentRunner)
        ),
      },
      {
        label: 'approval-reason',
        run: () => (
          (currentRunner = makeRunner('approval-reason')),
          scenarioApprovalReason(currentRunner)
        ),
      },
    ]
    blocks.push(...hermetic.filter((block) => scenarioSelected(block.label)))
    if (realEnabled && scenarioSelected('real')) {
      blocks.push({
        label: 'real',
        run: () => (
          (currentRunner = makeRunner('real')),
          scenarioReal(currentRunner)
        ),
      })
    }
  }

  if (!tsAvailable) {
    for (const name of [
      'chat',
      'resume',
      'approval-allow',
      'approval-deny',
      'stop',
      'mobile',
      'appearance-density',
      'provider-reset',
      'folding',
      'plan-dock',
      'composer-seats',
      'hero-starters',
      'composer-recall',
      'approval-reason',
      'real',
    ].filter(scenarioSelected)) {
      results.push({
        name,
        status: 'SKIP',
        secs: '0.0',
        note: 'packages/harness/dist/cli.js not built (cd packages/harness && npm run build)',
      })
    }
  }

  for (const b of blocks) {
    blockStart = Date.now()
    currentRunner = null
    try {
      await b.run()
    } catch (e) {
      const name = currentRunner?.current ?? b.label
      if (e instanceof SkipError) {
        results.push({ name, status: 'SKIP', secs: pendingSecs(), note: e.message })
        log(`SKIP [${name}]: ${e.message}`)
      } else {
        results.push({ name, status: 'FAIL', secs: pendingSecs(), note: e.message })
        log(`\nFAIL [${name}]: ${e.stack ?? e.message}\n`)
      }
    }
  }

  if (!realEnabled && tsAvailable && scenarioSelected('real')) {
    results.push({
      name: 'real',
      status: 'SKIP',
      secs: '0.0',
      note: 'set TWO_BROTHERS_REAL_E2E=1',
    })
  }

  // summary
  log('\n=== Two Brothers E2E summary ===')
  let failures = 0
  for (const r of results) {
    if (r.status === 'FAIL') failures++
    const note = r.note ? `  (${r.note})` : ''
    log(`${r.status.padEnd(4)}  ${r.name.padEnd(20)}  ${r.secs}s${note}`)
  }
  log(`total: ${((Date.now() - t0) / 1000).toFixed(1)}s, failures: ${failures}`)
  return failures
}

process.on('uncaughtException', (e) => {
  log(`uncaught: ${e.stack ?? e.message}`)
  process.exitCode = 1
})

const failures = await main()
if (browser) await browser.close().catch(() => {})
// hard reap anything still alive
for (const p of children) {
  try {
    execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } catch {}
}
process.exit(failures ? 1 : 0)
