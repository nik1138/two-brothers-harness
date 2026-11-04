// Two Brothers — browser end-to-end suite (plain Node runner + Playwright).
//
// Scenarios (each hermetic, deterministic, offline unless noted):
//   chat           mock provider: full cooperation cycle in the group chat
//   resume         reload after chat: session list + conversation history
//   approval-allow scripted fixture: approve a workspace write -> file exists, UI shows diff
//   approval-deny  scripted fixture: deny the write -> file absent
//   stop           scripted fixture: stop a slow run -> cancelled state
//   real           opt-in (TWO_BROTHERS_REAL_E2E=1): real models via LM Studio
//
// Backend: every scenario runs against the TypeScript server
// (node packages/harness/dist/cli.js serve) with TWO_BROTHERS_PROVIDER=mock or
// a scripted model server, depending on the scenario.
//
// Fixture-based scenarios drive fixtures/scripted-server.mjs (a scripted
// OpenAI-compatible model server the TS server talks to via
// TWO_BROTHERS_PROVIDER=openai + TWO_BROTHERS_BASE_URL); they are SKIPPED
// (not failed) while the built CLI is missing.
// The real scenario is SKIPPED (not failed) unless TWO_BROTHERS_REAL_E2E=1
// and both LM Studio models are listed by /v1/models.

import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const TS_CLI = path.join(ROOT, 'packages', 'harness', 'dist', 'cli.js')
const NODE_SCRIPTED = path.join(HERE, 'fixtures', 'scripted-server.mjs')
const WEB_DIST_INDEX = path.join(ROOT, 'web', 'dist', 'index.html')
const TASK_TEXT = 'Plan a migration from Redis to Valkey'
const HELLO_FILE = 'e2e-hello.txt'

// -- backend -----------------------------------------------------------------
// The built TypeScript CLI is the only backend; without it every scenario is
// reported as SKIP instead of being attempted.
const tsAvailable = fs.existsSync(TS_CLI)

// -- real-model scenario (opt-in) ------------------------------------------------
// LM Studio serves both roles over the OpenAI-compatible API; no api_key needed.
const LMSTUDIO_BASE = process.env.TWO_BROTHERS_LM_BASE || 'http://172.18.0.1:1234/v1'
const SENIOR_MODEL = 'spark-x2.6-4b@q4_k_m'
const JUNIOR_MODEL = 'lfm3-1.7b'
const REAL_TASK = 'In one sentence: what is a reversible migration?'
const REAL_DEADLINE_MS = 10 * 60 * 1000
const LM_PROBE_MS = 5000

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
 *   scenario fixture scenario name (approval | slow)
 * The returned handle may carry a `modelServer` (fixture runs) that
 * killBackend() tears down with the backend itself.
 */
async function startBackend({ kind, scenario }) {
  const port = await freePort()
  const dir = tmpDir('tb-e2e-ts')
  let modelServer = null
  let env
  if (kind === 'mock') {
    env = tsEnv({ TWO_BROTHERS_PROVIDER: 'mock' })
  } else {
    const modelPort = await freePort()
    modelServer = spawnServer(
      [NODE_SCRIPTED, '--port', String(modelPort), '--scenario', scenario],
      'ts-model',
    )
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

/** Follow /api/runs/{run_id}/events until the run_end event (or the deadline). */
async function followRunEvents(base, runId, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const events = []
  try {
    const res = await fetch(`${base}/api/runs/${runId}/events`, { signal: ctrl.signal })
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
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const ev = JSON.parse(line.slice('data: '.length))
          events.push(ev)
          if (ev.type === 'run_end') return events
        }
      }
    }
    throw new Error('SSE stream ended without a run_end event')
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(
        `run ${runId} did not reach run_end within ${Math.round(timeoutMs / 60000)} min`,
      )
    }
    throw e
  } finally {
    clearTimeout(timer)
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
  await dialog.locator('input').first().fill(dirPath)
  await dialog.locator('button[type="submit"]').click()
  await dialog.waitFor({ state: 'hidden', timeout: 10000 })
}

async function workspaceOptions(page) {
  return page.locator('select[title="Filter sessions by workspace"] option').allInnerTexts()
}

/** Ensure the sidebar filter offers `name`; add the workspace via the UI if not.
 *  NOTE: the app only loads workspaces on mount (App.vue), so after adding one
 *  we reload the page to see it — see "bugs found" in the report. */
async function ensureWorkspace(page, dirPath, name) {
  const opts = await workspaceOptions(page)
  if (opts.includes(name)) return
  await addWorkspaceViaDialog(page, dirPath)
  await page.reload()
  await page.locator('nav[aria-label="Sessions"]').waitFor()
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
  await dialog.locator('button[type="submit"]').click()
  await dialog.waitFor({ state: 'hidden', timeout: 10000 })
  await page.locator('.chat-scroll').waitFor({ state: 'visible' })
}

async function sendTask(page, task, { mode = 'consult', provider = 'mock' } = {}) {
  if (mode !== 'consult') {
    await page.locator('select[title="Cooperation mode"]').selectOption(mode)
  }
  if (provider !== 'mock') {
    await page.locator('select[title="Provider override for this run"]').selectOption(provider)
  }
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
    for (const who of ['Operator', 'Senior', 'Junior']) {
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

    runner.pass('resume')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: approval (allow / deny) ------------------------------------------------

async function approvalFlow(runner, decision) {
  const wsDir = tmpDir(`tb-e2e-ws-appr-${decision}`)
  const wsName = path.basename(wsDir)
  const be = await startBackend({ kind: 'fixture', scenario: 'approval' })
  const context = await browser.newContext()
  const page = await context.newPage()
  const helloPath = path.join(wsDir, HELLO_FILE)
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, `E2E approval ${decision}`)
    // let the scripted server drive: no provider override
    await sendTask(page, 'Write the hello file in the workspace', {
      mode: 'work',
      provider: '',
    })

    const card = page.locator('article.approval', { hasText: 'awaiting operator' })
    await card.first().waitFor({ timeout: 30000 })
    await card
      .first()
      .locator('button.approval-btn', { hasText: decision === 'allow' ? 'Allow' : 'Deny' })
      .click()

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
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, 'E2E stop')
    await sendTask(page, 'Start a long-running task', { mode: 'consult', provider: '' })

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
    runner.pass('stop')
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

    // provider: '' keeps the shared sendTask helper from selecting the mock
    // override — the run must take its models from the settings above
    const t0 = Date.now()
    await sendTask(page, REAL_TASK, { provider: '' })

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
    for (const who of ['Operator', 'Senior', 'Junior']) {
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
  await launchBrowser()
  log(`browser: ${browserLabel}`)
  log('backend: TypeScript server (packages/harness/dist/cli.js serve)')

  const realEnabled = process.env.TWO_BROTHERS_REAL_E2E === '1'

  // Every scenario runs against the TypeScript backend. The fixture-driven
  // ones drive the built-in openai provider against the Node scripted model
  // server (fixtures/scripted-server.mjs, always present).
  const blocks = []
  if (tsAvailable) {
    blocks.push(
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
    )
    if (realEnabled) {
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
    for (const name of ['chat', 'resume', 'approval-allow', 'approval-deny', 'stop', 'real']) {
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

  if (!realEnabled && tsAvailable) {
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
