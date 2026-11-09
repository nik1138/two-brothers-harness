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
//   appearance-accent mock provider: Settings -> Appearance accent radio group
//                  changes the root `data-accent` attribute and the effective
//                  accent token (keyboard-selected Violet), survives a reload,
//                  and restores the default blue palette
//   appearance-roles mock provider: Settings -> Appearance role-colour radio
//                  group changes the root `data-roles` attribute and the role
//                  identity + decorative fill tokens (keyboard-selected High
//                  contrast in light and dark, then the Neutral muted palette;
//                  the rendered role dots follow the fill tokens), survives a
//                  reload, and restores the default palette
//   keybindings   mock provider: Settings -> Keyboard rebinds the palette chord
//                  from a real Ctrl+Shift+P capture (applied immediately, old
//                  Ctrl+K dead, header + /help follow); a duplicate is rejected
//                  inline and Escape cancels capture without closing Settings;
//                  the custom chord survives a reload and "Reset all to
//                  defaults" restores Ctrl+K
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
//   tool-preview  scripted fixture: a workspace_list_dir result's additive
//                  bounded `preview` makes the completed tool card expandable;
//                  its toggle is keyboard-operable (aria-expanded), the plain-
//                  text <pre> lists entry types/names, and collapsing hides it
//                  again
//   workspace-drag mock provider: three registered workspaces (API) show group
//                  headers; dragging a group by its dedicated handle reorders
//                  the sidebar optimistically and persists through
//                  PUT /api/workspaces/order, with an honest drop indicator,
//                  no accidental session selection/filter change, plain clicks
//                  still collapsing/selecting, and the menu Move up/down
//                  fallback still working
//   reasoning-replay scripted fixture: a marked task is answered with SSE
//                  `delta.reasoning_content` chunks, so the backend persists
//                  bounded `reasoning` runtime events; after a reload the web
//                  replays them as collapsed "Thinking · replayed" rows —
//                  expandable plain text (literal HTML stays escaped text), the
//                  over-long record clipped with the honest marker, and a plain
//                  reply (no reasoning events) shows no row at all
//   cooperation-surfaces scripted fixture: a run-created file is previewed and
//                  undone, "Fork session…" opens a copied session and leaves
//                  the source byte-identical, the fork's second turn is rewound
//                  away, and a mid-run steer proves rejected drafts survive
//                  while an accepted Alt+Enter POST clears the composer
//   tab-title      scripted fixture: the selected session's document title is
//                  "<session> — Two Brothers", gains the documented `▶ ` marker
//                  while the run is live and `! ` while it waits for an
//                  approval, and returns to the plain title when it completes;
//                  the unread `(N) Two Brothers` count appears only with no
//                  session selected (opening the unread session consumes it)
//   settings-advanced mock provider: Settings → Advanced shows the
//                  Auto-compaction card with its four labelled budgets; a
//                  negative value is refused by the input's native floor
//                  (no PUT), a native-valid but non-whole value is an inline
//                  `role=alert` that blocks the save before any PUT, and a
//                  valid save persists the `compaction` section through the
//                  real /api/settings route (and sessions/settings.json) and
//                  survives a reload
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
/**
 * The built CLI. `TWO_BROTHERS_E2E_CLI` is an optional iteration seam that
 * points at a different built package layout (the default is the repo's
 * `packages/harness/dist`); the packaged web copy is then resolved next to
 * that layout, exactly like `resolveDefaultWebDist` does for the server.
 */
const TS_CLI = process.env.TWO_BROTHERS_E2E_CLI
  ? path.resolve(process.env.TWO_BROTHERS_E2E_CLI)
  : path.join(ROOT, 'packages', 'harness', 'dist', 'cli.js')
const NODE_SCRIPTED = path.join(HERE, 'fixtures', 'scripted-server.mjs')
const WEB_DIST_INDEX = path.join(ROOT, 'web', 'dist', 'index.html')
const WEB_DIST_DIR = path.join(ROOT, 'web', 'dist')
/** The copy the TS server serves first in a checkout (see server.ts). */
const PACKAGED_WEB_DIR = path.resolve(path.dirname(TS_CLI), '..', 'web')
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
// `TWO_BROTHERS_E2E_TMP_ROOT` is an optional iteration seam for a sealed
// workspace where the default root is not writable; it never leaves the repo.
const TMP_ROOT = process.env.TWO_BROTHERS_E2E_TMP_ROOT
  ? path.resolve(process.env.TWO_BROTHERS_E2E_TMP_ROOT)
  : path.join(ROOT, '.e2e-tmp')
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
    /**
     * Assert no console/page errors, optionally allowing explicitly expected
     * diagnostics. Use `allow` only for a deliberate synthetic response the
     * scenario itself injects (Chromium logs one "Failed to load resource"
     * console error per 4xx/5xx fetch); never for an app-side TypeError.
     */
    assertClean(allow = []) {
      const unexpected = errors.filter((error) => !allow.some((re) => re.test(error)))
      assert.ok(
        unexpected.length === 0,
        `browser console must stay clean — got ${unexpected.length} error(s):\n${unexpected.join('\n')}`,
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

/** Ambient TWO_BROTHERS_* env must never leak into a TS run: every scenario
 *  pins exactly the provider/compaction/approval settings it needs. */
function tsEnv(overrides = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('TWO_BROTHERS_')) delete env[key]
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
 *   scenario fixture scenario name (approval | slow | plan | folding | delete |
 *            reasoning | cooperation)
 *   lingerMs optional --linger-ms forwarded to the fixture (slow's first
 *            answer delay; folding's second-run deliverable delay; cooperation's
 *            `e2e-steer` opening delay)
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

    // -- per-message actions never cover the bubble (visual regression) ------
    // A one-word operator turn reproduces the tightest layout: the fork,
    // rewind and copy controls must sit beside the bubble, never over "OK".
    await sendTask(page, 'OK')
    await waitForRunEnd(page)
    await waitFor(
      async () => (await page.locator('.chat-group.side-operator').count()) === 2,
      { desc: 'the second operator turn after the short task' },
    )
    const shortTurn = page.locator('.chat-group.side-operator').last()
    await shortTurn.scrollIntoViewIfNeeded()
    const shortWrap = shortTurn.locator('.bubble-wrap')
    await shortWrap.hover()
    const toolbar = shortTurn.locator('.bubble-actions')
    await toolbar.waitFor({ state: 'visible' })
    await waitFor(
      async () => (await toolbar.evaluate((el) => getComputedStyle(el).opacity)) === '1',
      { desc: 'the per-message toolbar to appear on hover' },
    )
    const actionLayout = await shortTurn.evaluate((group) => {
      const bubble = group.querySelector('.bubble')
      const body = bubble.querySelector('.bubble-body') ?? bubble
      const actions = group.querySelector('.bubble-actions')
      const textRange = document.createRange()
      textRange.selectNodeContents(body)
      const rect = (el) => el.getBoundingClientRect().toJSON()
      return {
        text: body.textContent.trim(),
        bubble: rect(bubble),
        textRect: textRange.getBoundingClientRect().toJSON(),
        actions: rect(actions),
        buttons: [...actions.querySelectorAll('button')].map((button) => ({
          label: button.textContent.trim(),
          ...rect(button),
        })),
      }
    })
    assert.equal(actionLayout.text, 'OK', 'the short operator turn must stay a one-word bubble')
    assert.ok(
      actionLayout.actions.right <= actionLayout.bubble.left + 0.5,
      `the action row must sit outside the bubble (row=${JSON.stringify(actionLayout.actions)}, bubble=${JSON.stringify(actionLayout.bubble)})`,
    )
    for (const button of actionLayout.buttons) {
      assert.ok(
        !rectsOverlap(button, actionLayout.textRect),
        `the ${button.label} action overlaps the message text (button=${JSON.stringify(button)}, text=${JSON.stringify(actionLayout.textRect)})`,
      )
    }
    for (let i = 0; i < actionLayout.buttons.length; i++) {
      for (let j = i + 1; j < actionLayout.buttons.length; j++) {
        assert.ok(
          !rectsOverlap(actionLayout.buttons[i], actionLayout.buttons[j]),
          `per-message actions overlap each other: ${actionLayout.buttons[i].label}/${actionLayout.buttons[j].label}`,
        )
      }
    }
    // Keyboard focus reveals the same toolbar (no hover required).
    await page.mouse.move(0, 0)
    await waitFor(
      async () => (await toolbar.evaluate((el) => getComputedStyle(el).opacity)) === '0',
      { desc: 'the toolbar to hide when the pointer leaves' },
    )
    await toolbar.locator('button').first().focus()
    await waitFor(
      async () => (await toolbar.evaluate((el) => getComputedStyle(el).opacity)) === '1',
      { desc: 'the toolbar to appear for keyboard focus' },
    )

    // -- quote appends to the unsent draft (never replaces, never sends) ------
    const composerInput = page.locator('textarea.composer-input')
    await composerInput.fill('Keep this draft')
    await shortWrap.hover()
    await shortTurn.locator('.bubble-quote').click()
    const quotedWhole = await composerInput.inputValue()
    assert.equal(
      quotedWhole,
      'Keep this draft\n\n> OK\n\n',
      `the whole-message quote must append after the draft (got ${JSON.stringify(quotedWhole)})`,
    )
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'composer-input',
      'quoting must focus the composer',
    )
    assert.equal(
      await composerInput.evaluate((el) => el.selectionStart),
      quotedWhole.length,
      'the caret must sit after the inserted quote',
    )

    // A live selection inside the bubble body is quoted instead of the whole
    // message; the action must read it before the browser clears it.
    await composerInput.fill('Selection draft')
    const decisionBubble = decision.first()
    const decisionWrap = decisionBubble.locator('xpath=..')
    const decisionBody = decisionBubble.locator('.bubble-body')
    await decisionBubble.scrollIntoViewIfNeeded()
    await decisionWrap.hover()
    const selectedText = await decisionBody.evaluate((body) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && !node.textContent) node = walker.nextNode()
      if (!node || !node.textContent) return ''
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(24, node.textContent.length))
      const selection = window.getSelection()
      if (!selection) return ''
      selection.removeAllRanges()
      selection.addRange(range)
      return selection.toString()
    })
    assert.ok(selectedText.trim().length > 0, 'the selection probe must select decision text')
    await decisionWrap.locator('.bubble-quote').click()
    const quotedSelection = await composerInput.inputValue()
    const firstSelectedLine = selectedText.split('\n')[0].trimEnd()
    assert.ok(
      quotedSelection.startsWith('Selection draft\n\n> '),
      `the selection quote must append after the draft (got ${JSON.stringify(quotedSelection)})`,
    )
    assert.ok(
      quotedSelection.includes(`> ${firstSelectedLine}`),
      `the selected text must be quoted (expected ${JSON.stringify(firstSelectedLine)})`,
    )
    assert.ok(
      !quotedSelection.includes('> OK'),
      'a fresh selection must not reuse the earlier whole-message quote',
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

/** True when two DOMRects overlap by more than a sub-pixel seam. */
function rectsOverlap(a, b, tolerance = 0.5) {
  return (
    a.left < b.right - tolerance &&
    b.left < a.right - tolerance &&
    a.top < b.bottom - tolerance &&
    b.top < a.bottom - tolerance
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

// -- scenario: Settings -> Appearance accent theme -----------------------------------
// The accent chooser is a native radio group persisted in the uiPrefs blob and
// applied as `data-accent` on <html>; tokens.css owns the violet/teal/amber
// palettes (blue is the base :root palette). Verifies the default, a keyboard-
// chosen non-default accent (root attribute + computed accent token), reload
// persistence, and restoring the default — with the theme/density groups intact.
// Under the dark variant it also asserts the text-only `--accent-text` token is
// the lightened AA-compliant value (computed contrast vs the dark panel), and a
// native naive-ui primary control (the Settings Save button) follows the accent
// in light and dark and returns to the base primary after restoring Blue.

async function scenarioAppearanceAccent(runner) {
  const be = await startBackend({ kind: 'mock' })
  const { context, page, consoleGuard } = await newScenarioPage()
  const accentAttribute = () =>
    page.evaluate(() => document.documentElement.getAttribute('data-accent'))
  const accentToken = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    )
  /** The settings dialog's stable native naive-ui primary action. */
  const nativePrimary = (dialog) =>
    dialog.locator('.settings-footer-actions button.n-button--primary-type').first()
  /** Computed background colour of that native primary control. */
  const nativePrimaryBackground = async (dialog) => {
    const button = nativePrimary(dialog)
    await button.waitFor({ state: 'visible' })
    await waitFor(async () => !(await button.isDisabled()), {
      desc: 'the native settings primary button to be enabled',
    })
    return button.evaluate((el) => getComputedStyle(el).backgroundColor)
  }
  /** True when an rgb() string is within a small channel tolerance of `hex`. */
  const matchesHex = (actual, hex) => {
    const channels = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number)
    const expected = (hex.replace('#', '').match(/../g) ?? []).map((pair) =>
      Number.parseInt(pair, 16),
    )
    const rgb = channels(actual)
    return (
      rgb.length === 3 && rgb.every((channel, index) => Math.abs(channel - expected[index]) <= 2)
    )
  }
  /**
   * Assert the native naive-ui primary control follows `hex` (polled: the
   * naive-ui CSS variables are applied on Vue's next render flush).
   */
  const assertNativePrimary = async (dialog, hex, label) => {
    await waitFor(async () => matchesHex(await nativePrimaryBackground(dialog), hex), {
      desc: `${label} (native naive-ui primary background ${hex})`,
    })
  }
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    // Default: the base palette, with the attribute written on mount.
    assert.equal(await accentAttribute(), 'blue', 'the default accent is blue')
    assert.equal(await accentToken(), '#3568d4', 'blue is the base accent token')

    const { dialog, pane } = await openAppearanceSettings(page)
    assert.equal(
      await pane.locator('.appearance-card').count(),
      5,
      'the theme + density card groups stay exactly 5 cards',
    )
    // Native naive-ui primary controls follow the same accent (blue at rest).
    await assertNativePrimary(dialog, '#3568d4', 'default blue native primary')
    const accentGroup = pane.getByRole('radiogroup', { name: 'Accent' })
    assert.equal(
      await accentGroup.locator('input[type="radio"]').count(),
      4,
      'four accent options are offered',
    )
    assert.equal(
      await accentGroup.locator('input[name="accent-theme"]:checked').inputValue(),
      'blue',
      'blue is selected initially',
    )

    // Keyboard-only change: focus the checked radio and use native radio-group
    // arrow navigation (no mouse), which checks the next option (Violet).
    await accentGroup.locator('input[name="accent-theme"][value="blue"]').focus()
    await page.keyboard.press('ArrowDown')
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-accent') === 'violet',
      null,
      { timeout: 5000 },
    )
    assert.equal(
      await accentGroup.locator('input[name="accent-theme"]:checked').inputValue(),
      'violet',
      'keyboard navigation selects the Violet accent',
    )
    assert.equal(await accentToken(), '#6d28d9', 'violet changes the effective accent token')
    await assertNativePrimary(dialog, '#6d28d9', 'light violet native primary')
    assert.equal(
      await pane.locator('.appearance-card').count(),
      5,
      'changing the accent leaves the theme/density cards untouched',
    )

    // The accent is independent of the light/dark control and follows the dark
    // variant block after switching the theme.
    const themeCard = (label) =>
      pane
        .locator('.appearance-card')
        .filter({ has: page.locator(`.appearance-name:text-is("${label}")`) })
    await themeCard('Dark').click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      null,
      { timeout: 5000 },
    )
    assert.equal(await accentAttribute(), 'violet', 'the accent survives a theme change')
    assert.equal(await accentToken(), '#7c3aed', 'the dark violet accent block applies in dark')
    await assertNativePrimary(dialog, '#7c3aed', 'dark violet native primary')

    // The text-only accent token is lightened for AA contrast on dark surfaces.
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim(),
      ),
      '#a78bfa',
      'the dark violet accent text is the lightened AA value',
    )
    const darkTextContrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      const channels = (hex) =>
        hex.trim().replace('#', '').match(/../g).map((pair) => Number.parseInt(pair, 16))
      const luminance = (hex) => {
        const [r, g, b] = channels(hex).map((channel) => {
          const c = channel / 255
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const text = luminance(style.getPropertyValue('--accent-text'))
      const panel = luminance(style.getPropertyValue('--surface-panel'))
      return (Math.max(text, panel) + 0.05) / (Math.min(text, panel) + 0.05)
    })
    assert.ok(
      darkTextContrast >= 4.5,
      `dark accent text contrast is ${darkTextContrast.toFixed(2)}:1 (WCAG AA needs 4.5:1)`,
    )

    // Reload: the uiPrefs blob and the theme both survive; the dark accent is
    // re-applied with the pinned dark palette.
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    assert.equal(await accentAttribute(), 'violet', 'the violet accent survives a reload')
    assert.equal(await accentToken(), '#7c3aed', 'the reloaded page keeps the dark violet palette')
    const { dialog: reloadedDialog } = await openAppearanceSettings(page)
    assert.equal(
      await page
        .getByRole('radiogroup', { name: 'Accent' })
        .locator('input[name="accent-theme"]:checked')
        .inputValue(),
      'violet',
      'the chooser restores the stored selection',
    )

    // Back to the light theme and the default accent: both variants go away.
    const reloadedPane = page.locator('[role="region"][aria-label="Appearance"]')
    await reloadedPane
      .locator('.appearance-card')
      .filter({ has: page.locator('.appearance-name:text-is("Light")') })
      .click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
      null,
      { timeout: 5000 },
    )
    assert.equal(await accentToken(), '#6d28d9', 'light restores the light violet accent block')
    await page.locator('.accent-option', { hasText: 'Blue' }).click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-accent') === 'blue',
      null,
      { timeout: 5000 },
    )
    assert.equal(await accentToken(), '#3568d4', 'blue restores the default accent token')
    await assertNativePrimary(reloadedDialog, '#3568d4', 'restored blue native primary')
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    assert.equal(await accentAttribute(), 'blue', 'restoring the default survives a reload')
    assert.equal(await accentToken(), '#3568d4', 'the reloaded default palette is the base one')

    consoleGuard.assertClean()
    runner.pass('appearance-accent')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: Settings -> Appearance role-colour palette -------------------------------
// The role chooser is a native radio group persisted in the uiPrefs blob and
// applied as `data-roles` on <html>; tokens.css owns the contrast/neutral role
// palettes (default is the base :root role tokens). Verifies the default, a
// keyboard-chosen high-contrast palette in light and dark (root attribute +
// computed role identity and decorative fill tokens + the rendered role dots,
// which follow the fill tokens), reload persistence, the neutral muted palette,
// and restoring the default — with the theme/density `.appearance-card` group
// still at 5 cards.

async function scenarioAppearanceRoles(runner) {
  const be = await startBackend({ kind: 'mock' })
  const { context, page, consoleGuard } = await newScenarioPage()
  const roleAttribute = () =>
    page.evaluate(() => document.documentElement.getAttribute('data-roles'))
  const roleTokens = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        senior: style.getPropertyValue('--senior').trim(),
        junior: style.getPropertyValue('--junior').trim(),
        operator: style.getPropertyValue('--operator').trim(),
      }
    })
  /** The decorative fill companions painted behind avatars and role dots. */
  const roleFillTokens = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        senior: style.getPropertyValue('--senior-fill').trim(),
        junior: style.getPropertyValue('--junior-fill').trim(),
        operator: style.getPropertyValue('--operator-fill').trim(),
      }
    })
  /** The rendered role dots (Models & roles pane, mounted when Settings opens). */
  const roleDotBackgrounds = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.role-dot')].map(
        (dot) => getComputedStyle(dot).backgroundColor,
      ),
    )
  /** True when an rgb() string is within a small channel tolerance of `hex`. */
  const matchesHex = (actual, hex) => {
    const channels = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number)
    const expected = (hex.replace('#', '').match(/../g) ?? []).map((pair) =>
      Number.parseInt(pair, 16),
    )
    const rgb = channels(actual)
    return (
      rgb.length === 3 && rgb.every((channel, index) => Math.abs(channel - expected[index]) <= 2)
    )
  }
  const themeCard = (pane, label) =>
    pane
      .locator('.appearance-card')
      .filter({ has: page.locator(`.appearance-name:text-is("${label}")`) })
  const waitForRoleTokens = async (expected, label) => {
    await waitFor(
      async () => {
        const tokens = await roleTokens()
        return Object.entries(expected).every(([name, value]) => tokens[name] === value)
      },
      { desc: label },
    )
  }
  const waitForRoleFills = async (expected, label) => {
    await waitFor(
      async () => {
        const tokens = await roleFillTokens()
        return Object.entries(expected).every(([name, value]) => tokens[name] === value)
      },
      { desc: label },
    )
  }
  const LIGHT_BASE = { senior: '#3568d4', junior: '#0d7f69', operator: '#6f7684' }
  const LIGHT_CONTRAST = { senior: '#2456d2', junior: '#0f6d5a', operator: '#545c6a' }
  const DARK_CONTRAST = { senior: '#7d9fdd', junior: '#46baa0', operator: '#a3abba' }
  // The dark high-contrast fills are darker than its lightened text tokens so
  // the white avatar/dot glyphs keep AA contrast; the light palettes reuse the
  // role values, which already clear that floor.
  const DARK_CONTRAST_FILL = { senior: '#3b64c9', junior: '#1a7a66', operator: '#666e7c' }
  const LIGHT_NEUTRAL = { senior: '#3f4653', junior: '#515866', operator: '#616876' }
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    // Default: the base role palette, with the attribute written on mount. The
    // fill companions equal the role tokens, so the default look is unchanged.
    assert.equal(await roleAttribute(), 'default', 'the default role palette is default')
    assert.deepEqual(await roleTokens(), LIGHT_BASE, 'default is the base :root role palette')
    assert.deepEqual(
      await roleFillTokens(),
      LIGHT_BASE,
      'the default fill tokens equal the role tokens (unchanged look)',
    )

    const first = await openAppearanceSettings(page)
    assert.equal(
      await first.pane.locator('.appearance-card').count(),
      5,
      'the theme + density card groups stay exactly 5 cards',
    )
    const roleGroup = first.pane.getByRole('radiogroup', { name: 'Role colours' })
    assert.equal(
      await roleGroup.locator('input[type="radio"]').count(),
      3,
      'three role-colour options are offered',
    )
    assert.equal(
      await roleGroup.locator('input[name="role-theme"]:checked').inputValue(),
      'default',
      'Default is selected initially',
    )
    const defaultDots = await roleDotBackgrounds()
    assert.ok(defaultDots.length >= 2, 'the role dots are rendered in the roles pane')
    assert.ok(
      matchesHex(defaultDots[0], LIGHT_BASE.senior),
      'the senior dot uses the default fill (equal to --senior)',
    )
    assert.ok(
      matchesHex(defaultDots[1], LIGHT_BASE.junior),
      'the junior dot uses the default fill (equal to --junior)',
    )

    // Keyboard-only change: focus the checked radio and use native radio-group
    // arrow navigation (no mouse), which checks the next option (High contrast).
    await roleGroup.locator('input[name="role-theme"][value="default"]').focus()
    await page.keyboard.press('ArrowDown')
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-roles') === 'contrast',
      null,
      { timeout: 5000 },
    )
    assert.equal(
      await roleGroup.locator('input[name="role-theme"]:checked').inputValue(),
      'contrast',
      'keyboard navigation selects the High contrast role palette',
    )
    await waitForRoleTokens(LIGHT_CONTRAST, 'the light high-contrast role tokens')
    await waitForRoleFills(LIGHT_CONTRAST, 'the light high-contrast role fill tokens')
    const contrastDots = await roleDotBackgrounds()
    assert.ok(
      matchesHex(contrastDots[0], LIGHT_CONTRAST.senior),
      'the senior dot follows the high-contrast fill',
    )
    assert.ok(
      matchesHex(contrastDots[1], LIGHT_CONTRAST.junior),
      'the junior dot follows the high-contrast fill',
    )

    // The palette is independent of the light/dark control and follows the dark
    // role blocks after switching the theme.
    await themeCard(first.pane, 'Dark').click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      null,
      { timeout: 5000 },
    )
    assert.equal(await roleAttribute(), 'contrast', 'the role palette survives a theme change')
    await waitForRoleTokens(DARK_CONTRAST, 'the dark high-contrast role tokens')
    // The dark palette lightens the role text tokens for dark surfaces, so the
    // decorative dots must follow the dedicated (darker) fill tokens instead.
    await waitForRoleFills(DARK_CONTRAST_FILL, 'the dark high-contrast role fill tokens')
    const darkContrastDots = await roleDotBackgrounds()
    assert.ok(
      matchesHex(darkContrastDots[0], DARK_CONTRAST_FILL.senior),
      'the senior dot follows the dark high-contrast fill token',
    )
    assert.ok(
      matchesHex(darkContrastDots[1], DARK_CONTRAST_FILL.junior),
      'the junior dot follows the dark high-contrast fill token',
    )
    assert.ok(
      !matchesHex(darkContrastDots[0], DARK_CONTRAST.senior),
      'the dark fill and the lightened role text token stay distinct',
    )

    // Reload: both the uiPrefs blob and the theme survive; the dark role palette
    // is re-applied with the pinned dark tokens.
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    assert.equal(await roleAttribute(), 'contrast', 'the role palette survives a reload')
    await waitForRoleTokens(DARK_CONTRAST, 'the reloaded dark high-contrast role tokens')
    await waitForRoleFills(DARK_CONTRAST_FILL, 'the reloaded dark high-contrast role fill tokens')
    const reloaded = await openAppearanceSettings(page)
    assert.equal(
      await reloaded.pane
        .getByRole('radiogroup', { name: 'Role colours' })
        .locator('input[name="role-theme"]:checked')
        .inputValue(),
      'contrast',
      'the chooser restores the stored palette',
    )

    // Back to the light theme, then the muted neutral palette.
    await themeCard(reloaded.pane, 'Light').click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
      null,
      { timeout: 5000 },
    )
    await reloaded.pane.locator('.role-theme-option', { hasText: 'Neutral' }).click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-roles') === 'neutral',
      null,
      { timeout: 5000 },
    )
    await waitForRoleTokens(LIGHT_NEUTRAL, 'the light neutral role tokens')
    await waitForRoleFills(LIGHT_NEUTRAL, 'the light neutral role fill tokens')
    assert.equal(
      await reloaded.pane
        .getByRole('radiogroup', { name: 'Role colours' })
        .locator('input[name="role-theme"]:checked')
        .inputValue(),
      'neutral',
      'the neutral option is selected',
    )

    // Restore the default palette.
    await reloaded.pane.locator('.role-theme-option', { hasText: 'Default' }).click()
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-roles') === 'default',
      null,
      { timeout: 5000 },
    )
    await waitForRoleTokens(LIGHT_BASE, 'the restored base role tokens')
    await waitForRoleFills(LIGHT_BASE, 'the restored default role fill tokens')
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    assert.equal(await roleAttribute(), 'default', 'restoring the default survives a reload')
    assert.deepEqual(await roleTokens(), LIGHT_BASE, 'the reloaded default role palette is the base one')
    assert.deepEqual(
      await roleFillTokens(),
      LIGHT_BASE,
      'the reloaded default fill tokens equal the role tokens',
    )

    consoleGuard.assertClean()
    runner.pass('appearance-roles')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: configurable global key bindings -----------------------------------------
//
// First slice of the configurable-key-bindings epic: the palette, find and
// shortcut-reference chords are rebindable in Settings → Keyboard via a real
// keyboard capture, validated with inline conflict messages, persisted per
// device in the versioned localStorage store, applied immediately (header label
// and matcher), reflected in the /help table, and restored by "Reset all to
// defaults". Every other shortcut stays fixed. Hermetic: mock backend, no model
// run is needed.

async function scenarioKeybindings(runner) {
  const STORAGE_KEY = 'two-brothers.keybindings.v1'
  const be = await startBackend({ kind: 'mock' })
  const { context, page, consoleGuard } = await newScenarioPage()
  const paletteShown = async () => {
    const target = page.locator('.command-palette')
    return (await target.count()) > 0 && (await target.first().isVisible())
  }
  const waitPalette = (shown, desc) =>
    waitFor(async () => (await paletteShown()) === shown, { desc, timeout: 8000 })
  /** Open Settings → Keyboard and return the dialog + its visible pane. */
  const openKeyboardSettings = async () => {
    await page.locator('.sidebar-footer .footer-action').click()
    const dialog = page.locator('[role="dialog"][aria-labelledby="settings-dialog-title"]')
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
    const pane = dialog.locator('[role="region"][aria-label="Keyboard"]')
    await pane.waitFor({ state: 'visible' })
    return { dialog, pane }
  }
  const rowIn = (pane, action) => pane.locator(`.keyboard-row[data-action="${action}"]`)
  const keysIn = async (row) => row.locator('.keyboard-key').allInnerTexts()
  const storedBindings = async () => {
    const raw = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
    return raw === null ? null : JSON.parse(raw)
  }
  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    // -- baseline: the default chord opens the palette, the header says so
    assert.equal((await page.locator('.palette-chip-keys').innerText()).trim(), 'Ctrl+K')
    assert.equal(await paletteShown(), false)
    await page.keyboard.press('Control+K')
    await waitPalette(true, 'the default Ctrl+K to open the palette')
    await page.keyboard.press('Escape')
    await waitPalette(false, 'Escape to close the palette')

    // -- Settings → Keyboard lists the three rebindable chords
    const { dialog, pane } = await openKeyboardSettings()
    const paletteRow = rowIn(pane, 'palette')
    const findRow = rowIn(pane, 'find')
    assert.deepEqual(await keysIn(paletteRow), ['Ctrl', 'K'])
    assert.deepEqual(await keysIn(findRow), ['Ctrl', 'F'])
    assert.deepEqual(await keysIn(rowIn(pane, 'shortcut-help')), ['Ctrl', '/'])
    const status = pane.locator('.keyboard-status')
    assert.equal(await status.getAttribute('role'), 'status')
    assert.equal(await status.getAttribute('aria-live'), 'polite')

    // -- capture a new palette chord from a real keydown
    await paletteRow.locator('button.keyboard-change').click()
    await waitFor(
      async () =>
        (await paletteRow.locator('button.keyboard-change').innerText()).includes('Press keys'),
      { desc: 'the capture button to announce "Press keys…"' },
    )
    assert.match((await status.innerText()).trim(), /Press the new key combination/)
    await page.keyboard.press('Control+Shift+P')
    await waitFor(
      async () =>
        JSON.stringify(await keysIn(paletteRow)) === JSON.stringify(['Ctrl', 'Shift', 'P']),
      { desc: 'the captured Ctrl+Shift+P chord to render' },
    )
    assert.match((await status.innerText()).trim(), /Command palette is now Ctrl\+Shift\+P/)
    // persisted immediately in the versioned device store
    const saved = await storedBindings()
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.bindings.palette, { key: 'p', mod: true, shift: true, alt: false })
    // the header label follows the binding without a reload
    assert.equal((await page.locator('.palette-chip-keys').innerText()).trim(), 'Ctrl+Shift+P')

    // -- a duplicate chord is rejected inline (not saved), and Escape cancels
    //    the capture WITHOUT closing the Settings dialog (capture precedence)
    await findRow.locator('button.keyboard-change').click()
    await page.keyboard.press('Control+Shift+P')
    const inlineError = pane.locator('.keyboard-error')
    await inlineError.waitFor({ state: 'visible' })
    assert.equal(await inlineError.getAttribute('role'), 'alert')
    assert.match((await inlineError.innerText()).trim(), /already used by Command palette/)
    assert.deepEqual(await keysIn(findRow), ['Ctrl', 'F'], 'the conflicting chord was not applied')
    assert.deepEqual((await storedBindings()).bindings.find, {
      key: 'f',
      mod: true,
      shift: false,
      alt: false,
    })
    await page.keyboard.press('Escape')
    await waitFor(async () => (await dialog.isVisible()) && (await inlineError.count()) === 0, {
      desc: 'Escape to cancel capture while the Settings dialog stays open',
    })
    assert.match((await status.innerText()).trim(), /cancelled/)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })

    // -- the new chord works immediately; the old one no longer does
    await page.keyboard.press('Control+Shift+P')
    await waitPalette(true, 'the rebound Ctrl+Shift+P to open the palette')
    await page.keyboard.press('Escape')
    await waitPalette(false, 'Escape to close the palette')
    await page.keyboard.press('Control+K')
    await sleep(300)
    assert.equal(
      await paletteShown(),
      false,
      'the old Ctrl+K must not open the palette after rebinding',
    )

    // -- /help renders the current bindings; only the rebindable rows are marked
    //    (press the printable `?` directly: Playwright maps it to key '?', the
    //    same key a real keyboard reports for Shift+/)
    await page.keyboard.press('?')
    const helpDialog = page.locator('[role="dialog"]', { hasText: 'Keyboard shortcuts' }).first()
    await helpDialog.waitFor({ state: 'visible' })
    const helpPaletteRow = helpDialog.locator('.help-shortcut-row', {
      hasText: 'Open the command palette / search',
    })
    assert.deepEqual(await helpPaletteRow.locator('.help-key').allInnerTexts(), [
      'Ctrl',
      'Shift',
      'P',
    ])
    assert.equal(await helpPaletteRow.locator('.help-rebindable').count(), 1)
    assert.match(
      await helpDialog.locator('.help-hint').innerText(),
      /rebindable in Settings → Keyboard/,
    )
    const helpStopRow = helpDialog.locator('.help-shortcut-row', {
      hasText: 'Stop the running run',
    })
    assert.deepEqual(await helpStopRow.locator('.help-key').allInnerTexts(), ['Esc', 'Esc'])
    assert.equal(await helpStopRow.locator('.help-rebindable').count(), 0)
    await page.keyboard.press('Escape')
    await helpDialog.waitFor({ state: 'hidden' })

    // -- the custom chord survives a page reload and is still live
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    assert.equal((await page.locator('.palette-chip-keys').innerText()).trim(), 'Ctrl+Shift+P')
    await page.keyboard.press('Control+Shift+P')
    await waitPalette(true, 'the persisted Ctrl+Shift+P to open the palette after a reload')
    await page.keyboard.press('Escape')
    await waitPalette(false, 'Escape to close the palette')
    await page.keyboard.press('Control+K')
    await sleep(300)
    assert.equal(await paletteShown(), false, 'the old chord stays dead after a reload')

    // -- reset all restores the defaults immediately and persistently
    const reopened = await openKeyboardSettings()
    assert.deepEqual(await keysIn(rowIn(reopened.pane, 'palette')), ['Ctrl', 'Shift', 'P'])
    await reopened.pane.locator('button.keyboard-reset-all').click()
    await waitFor(
      async () =>
        JSON.stringify(await keysIn(rowIn(reopened.pane, 'palette'))) ===
        JSON.stringify(['Ctrl', 'K']),
      { desc: 'Reset all to restore the default Ctrl+K label' },
    )
    assert.deepEqual(await keysIn(rowIn(reopened.pane, 'find')), ['Ctrl', 'F'])
    assert.deepEqual(await keysIn(rowIn(reopened.pane, 'shortcut-help')), ['Ctrl', '/'])
    assert.deepEqual((await storedBindings()).bindings.palette, {
      key: 'k',
      mod: true,
      shift: false,
      alt: false,
    })
    await reopened.dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await reopened.dialog.waitFor({ state: 'hidden' })
    await page.keyboard.press('Control+K')
    await waitPalette(true, 'Ctrl+K to open the palette again after the reset')
    await page.keyboard.press('Escape')
    await waitPalette(false, 'Escape to close the palette')
    await page.keyboard.press('Control+Shift+P')
    await sleep(300)
    assert.equal(
      await paletteShown(),
      false,
      'the custom chord must not open the palette after the reset',
    )

    consoleGuard.assertClean()
    runner.pass('keybindings')
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

    // -- fall-through fix: with a non-empty single-line draft and recall
    //    inactive, ArrowDown must not be consumed by the recall wiring; the
    //    textarea keeps its native caret movement and nothing is recalled
    await caretTo('start')
    await page.keyboard.press('ArrowDown')
    const afterInactiveDown = await textarea.evaluate((el) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      length: el.value.length,
    }))
    assert.equal(
      await textarea.inputValue(),
      UNSENT_DRAFT,
      'an inactive ArrowDown must not recall or rewrite the draft',
    )
    assert.deepEqual(
      [afterInactiveDown.start, afterInactiveDown.end],
      [afterInactiveDown.length, afterInactiveDown.length],
      'an inactive ArrowDown must fall through to the native caret-to-end movement',
    )

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

// -- scenario: workspace tool-card preview --------------------------------------------
//
// A `workspace_list_dir` result is a JSON object the historical compact
// projection dropped entirely, so the web card showed only the tool name and
// status. The backend now emits an additive bounded `preview`; this scenario
// proves the card turns it into a keyboard-operable disclosure with plain-text
// rows (file/dir + name).

async function scenarioToolPreview(runner) {
  const FILE = 'e2e-preview-a.txt'
  const DIR = 'e2e-preview-dir'
  const wsDir = tmpDir('tb-e2e-ws-preview')
  const wsName = path.basename(wsDir)
  const be = await startBackend({ kind: 'fixture', scenario: 'list' })
  const { context, page, consoleGuard } = await newScenarioPage()
  try {
    fs.writeFileSync(path.join(wsDir, FILE), 'preview scenario file\n')
    fs.mkdirSync(path.join(wsDir, DIR))
    fs.writeFileSync(path.join(wsDir, DIR, 'nested.txt'), 'nested\n')

    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, 'E2E tool preview session')
    await sendTask(page, 'List the workspace root', { mode: 'work' })
    await waitForRunEnd(page)

    // A completed run may fold its rows; expand the summary first when present.
    const fold = page.locator('.fold-toggle')
    if ((await fold.count()) > 0) await fold.first().click()

    const card = page.locator('.tool-activity', { hasText: 'workspace_list_dir' })
    await card.first().waitFor({ state: 'visible', timeout: 10000 })
    const target = card.first().locator('.tool-target')
    assert.equal((await target.innerText()).trim(), '.', 'the card still shows its target path')
    const toggle = card.first().locator('button.tool-toggle')
    await toggle.waitFor({ state: 'visible' })
    assert.equal(
      await toggle.getAttribute('aria-expanded'),
      'false',
      'the preview starts collapsed behind the details toggle',
    )
    const preview = card.first().locator('pre.tool-preview')
    await preview.waitFor({ state: 'attached' })
    assert.equal(await preview.isVisible(), false, 'a collapsed preview body is hidden')

    // A real button: click opens; Enter on the focused toggle reopens it.
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    await preview.waitFor({ state: 'visible' })
    const rows = await preview.innerText()
    assert.match(rows, new RegExp(`^file ${FILE}$`, 'm'), `missing file row: ${rows}`)
    assert.match(rows, new RegExp(`^dir ${DIR}$`, 'm'), `missing dir row: ${rows}`)
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    await toggle.focus()
    await page.keyboard.press('Enter')
    assert.equal(
      await toggle.getAttribute('aria-expanded'),
      'true',
      'the toggle must be keyboard-operable',
    )
    await preview.waitFor({ state: 'visible' })

    // Vue interpolation only: the preview element has no child markup.
    assert.equal(await preview.locator('*').count(), 0, 'preview rows are plain text')

    // The preview never carries the whole listing beyond its backend cap and
    // the card summary counts its characters (non-zero size chip).
    assert.ok(rows.length <= 500, `preview must stay bounded (${rows.length} chars)`)
    const summary = card.first().locator('.tool-summary')
    assert.ok((await summary.count()) === 1, 'the preview size chip is present')

    // No raw protocol JSON leaks into the transcript.
    const transcript = await page.locator('.chat-scroll').innerText()
    assert.ok(!transcript.includes('{"v":1'), 'raw protocol JSON visible in chat')
    assert.ok(!transcript.includes('[[TASK]]'), 'raw [[TASK]] marker visible in chat')

    consoleGuard.assertClean()
    runner.pass('tool-preview')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
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

// -- scenario: workspace drag-and-drop reorder ---------------------------------
//
// Three registered workspaces (created through the API) plus two sessions make
// the sidebar render workspace group headers. Dragging a group by its dedicated
// handle (native HTML5 drag events, dispatched deterministically here) reorders
// the sidebar optimistically and persists through PUT /api/workspaces/order;
// the drop must not select a session or change the workspace filter, a plain
// header click still collapses/expands the group, a plain row click still
// selects a session, and the actions-menu Move up/down fallback still works.

async function scenarioWorkspaceDrag(runner) {
  const be = await startBackend({ kind: 'mock' })
  const wsDirs = [
    tmpDir('tb-e2e-ws-drag-a'),
    tmpDir('tb-e2e-ws-drag-b'),
    tmpDir('tb-e2e-ws-drag-c'),
  ]
  const names = wsDirs.map((dir) => path.basename(dir))
  const FIRST = names[0]
  const SECOND = names[1]
  const THIRD = names[2]
  const SESSION_ONE = 'E2E workspace drag session'
  const SESSION_TWO = 'E2E workspace drag second'
  const { context, page, consoleGuard } = await newScenarioPage()
  const groupByLabel = (label) =>
    page.locator('.session-group').filter({ has: page.locator(`.group-label:text-is("${label}")`) })
  const sidebarOrder = async () =>
    (await page.locator('.session-group .group-label').allInnerTexts())
      .map((label) => label.trim())
      .filter((label) => names.includes(label))
  const workspaceOrder = async () => {
    const list = await apiCall(be.base, 'GET', '/api/workspaces')
    assert.equal(list.status, 200, `GET /api/workspaces -> HTTP ${list.status}`)
    return (list.json ?? []).map((workspace) => workspace.name).filter((name) => names.includes(name))
  }
  try {
    for (const [index, dir] of wsDirs.entries()) {
      const created = await apiCall(be.base, 'POST', '/api/workspaces', {
        path: dir,
        name: names[index],
      })
      assert.equal(created.status, 201, `POST /api/workspaces -> HTTP ${created.status}`)
    }

    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    // Sessions are what makes the sidebar render its groups (otherwise it shows
    // the empty state); both stay unassigned so every workspace group is empty.
    await createSession(page, SESSION_ONE)
    await createSession(page, SESSION_TWO)
    await waitFor(async () => (await sidebarOrder()).length === names.length, {
      desc: 'three workspace group headers in the sidebar',
    })
    assert.deepEqual(await sidebarOrder(), names, 'the initial sidebar order is the API order')
    const filter = page.locator('select[title="Filter sessions by workspace"]')
    assert.equal(await filter.inputValue(), 'all')
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === SESSION_TWO,
      { desc: 'the newest session selected after creation' },
    )
    const titleBefore = (await page.locator('.chat-title').innerText()).trim()

    // -- drag the first group before the third ------------------------------
    const source = groupByLabel(FIRST)
    const target = groupByLabel(THIRD)
    const handle = source.locator('.group-drag-handle')
    const targetHeading = target.locator('.group-heading')
    await handle.waitFor({ state: 'attached' })
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    const targetBox = await targetHeading.boundingBox()
    assert.ok(targetBox, 'the third group header has a bounding box')

    await handle.dispatchEvent('dragstart', { dataTransfer })
    await waitFor(
      async () => ((await source.getAttribute('class')) ?? '').includes('is-dragging'),
      { desc: 'drag source marked while dragging' },
    )
    await targetHeading.dispatchEvent('dragover', {
      dataTransfer,
      clientX: targetBox.x + 8,
      clientY: targetBox.y + 2,
    })
    await waitFor(
      async () => ((await target.getAttribute('class')) ?? '').includes('is-drop-before'),
      { desc: 'honest drop indicator above the target group' },
    )
    await targetHeading.dispatchEvent('drop', {
      dataTransfer,
      clientX: targetBox.x + 8,
      clientY: targetBox.y + 2,
    })
    await handle.dispatchEvent('dragend', { dataTransfer })

    await waitFor(
      async () => JSON.stringify(await sidebarOrder()) === JSON.stringify([SECOND, FIRST, THIRD]),
      { desc: 'optimistic sidebar order after the drop' },
    )
    // The sidebar updates optimistically before the PUT resolves; poll the API
    // so a slow backend cannot race this assertion.
    await waitFor(
      async () => JSON.stringify(await workspaceOrder()) === JSON.stringify([SECOND, FIRST, THIRD]),
      { desc: 'the persisted API order after the drop' },
    )
    assert.deepEqual(await workspaceOrder(), [SECOND, FIRST, THIRD], 'the drop persisted via the API')
    assert.ok(
      !((await source.getAttribute('class')) ?? '').includes('is-dragging'),
      'the drag source state is cleared after the drop',
    )
    assert.ok(
      !((await target.getAttribute('class')) ?? '').includes('is-drop'),
      'the drop indicator is cleared after the drop',
    )

    // The drop is a reorder, never a navigation or a filter change.
    assert.equal(await filter.inputValue(), 'all', 'the drop must not change the workspace filter')
    assert.equal(
      (await page.locator('.chat-title').innerText()).trim(),
      titleBefore,
      'the drop must not select a different session',
    )

    // -- plain clicks keep working after a drag -----------------------------
    const firstToggle = groupByLabel(SECOND).locator('.group-toggle')
    await firstToggle.click()
    assert.equal(await firstToggle.getAttribute('aria-expanded'), 'false', 'header click collapses')
    await firstToggle.click()
    assert.equal(await firstToggle.getAttribute('aria-expanded'), 'true', 'header click expands')
    assert.deepEqual(
      await sidebarOrder(),
      [SECOND, FIRST, THIRD],
      'collapsing/expanding never reorders',
    )

    const firstSessionRow = page
      .locator('.session-row')
      .filter({ has: page.locator(`.session-title:text-is("${SESSION_ONE}")`) })
      .locator('.session-item')
    await firstSessionRow.click()
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === SESSION_ONE,
      { desc: 'a plain session-row click selects that session' },
    )

    // -- the workspace filter still works ----------------------------------
    await selectWorkspaceFilter(page, SECOND)
    await waitFor(async () => (await filter.inputValue()) !== 'all', {
      desc: 'the workspace filter selection',
    })
    // The filter narrows the sidebar to one workspace; drag handles belong to
    // the unfiltered multi-workspace list only, so none must remain.
    assert.equal(
      await page.locator('.group-drag-handle').count(),
      0,
      'dragging is disabled while filtering one workspace',
    )
    await filter.selectOption('all')
    await waitFor(async () => (await sidebarOrder()).length === names.length, {
      desc: 'the full workspace list after clearing the filter',
    })

    // -- the actions-menu fallback still reorders (keyboard path) ----------
    const firstGroup = groupByLabel(SECOND)
    await firstGroup.locator('.group-heading').hover()
    await firstGroup.locator('.group-menu-trigger').click()
    const menu = page.locator('.group-menu')
    await menu.waitFor({ state: 'visible' })
    assert.equal(
      await menu.locator('button[aria-label="Move workspace up"]').isDisabled(),
      true,
      'Move up is disabled for the first workspace',
    )
    assert.equal(
      await menu.locator('button[aria-label="Move workspace down"]').isDisabled(),
      false,
      'Move down is available for the first workspace',
    )
    await menu.locator('button[aria-label="Move workspace down"]').click()
    await waitFor(
      async () => JSON.stringify(await sidebarOrder()) === JSON.stringify(names),
      { desc: 'menu Move down restores the original order' },
    )
    assert.deepEqual(await workspaceOrder(), names, 'the menu fallback persisted via the API')

    consoleGuard.assertClean()
    runner.pass('workspace-drag')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    for (const dir of wsDirs) rmTree(dir)
    rmTree(be.dir)
  }
}

// -- scenario: persisted reasoning replay ----------------------------------------------
//
// The backend persists the model's streamed thinking as ONE bounded `reasoning`
// runtime event per provider call (runtime sidecar); the web never maps a live
// reasoning event into the transcript, it replays those persisted records as
// collapsed "Thinking · replayed" disclosure rows on a session load.
//
// This scenario drives the real streaming path: the web always requests
// `stream_tokens: true`, so the backend's provider calls opt into streaming and
// the scripted fixture answers the marked task with genuine SSE
// `delta.reasoning_content` chunks before the reply content. It then verifies
// the sidecar records via the API, reloads the page and asserts the replay
// contract: rows collapsed by default, an expanded row is plain sanitized text
// (literal HTML-looking reasoning never becomes markup), the over-long record is
// clipped with the honest marker, and a plain (non-streaming) reply in the same
// fixture process produces no replay row at all.

async function scenarioReasoningReplay(runner) {
  // Keep the prose markers in sync with fixtures/scripted-server.mjs.
  const REASONING_SESSION = 'E2E reasoning replay session'
  const PLAIN_SESSION = 'E2E plain reply session'
  const REASONING_TASK = 'Reasoning replay: e2e-reasoning explain the decision'
  const PLAIN_TASK = 'Plain reply: no scripted thinking should exist here'
  const HTML_PROBE = 'window.__e2e_reasoning_pwned'
  const LONG_HEAD = 'LONG_REASONING_HEAD'
  const LONG_TAIL = 'LONG_REASONING_TAIL'
  const CLIPPED_COPY = 'This reasoning was clipped for length.'
  const be = await startBackend({ kind: 'fixture', scenario: 'reasoning' })
  const { context, page, consoleGuard } = await newScenarioPage()

  /** The persisted runtime sidecar events for one session title. */
  const runtimeEventsOf = async (title) => {
    const name = await sessionNameByTitle(be.base, title)
    const response = await apiCall(
      be.base,
      'GET',
      `/api/sessions/${encodeURIComponent(name)}/events`,
    )
    assert.equal(response.status, 200, `GET session runtime events -> HTTP ${response.status}`)
    return response.json?.events ?? []
  }

  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    // -- 1. the marked task runs against the real SSE streaming path ----------
    await createSession(page, REASONING_SESSION)
    await sendTask(page, REASONING_TASK)
    await waitForRunEnd(page)

    const reasoningEvents = await waitFor(
      async () => {
        const events = (await runtimeEventsOf(REASONING_SESSION)).filter(
          (event) => event.type === 'reasoning',
        )
        return events.length > 0 ? events : null
      },
      { desc: 'bounded reasoning runtime events in the session sidecar' },
    )
    // one record per provider call: consult, proposal, review, decision
    assert.ok(
      reasoningEvents.length >= 4,
      `expected one reasoning record per node call, got ${reasoningEvents.length}`,
    )
    for (const event of reasoningEvents) {
      assert.ok(
        event.role === 'senior' || event.role === 'junior',
        `reasoning record role: ${JSON.stringify(event.role)}`,
      )
      assert.equal(typeof event.kind, 'string', 'reasoning records must name the node kind')
      assert.equal(typeof event.text, 'string', 'reasoning records must carry text')
      assert.equal(
        typeof event.truncated,
        'boolean',
        'reasoning records must carry the truncation flag',
      )
      assert.equal(typeof event.run_id, 'string', 'reasoning records must carry their run id')
      assert.equal(typeof event.at, 'number', 'reasoning records must carry an epoch time')
    }
    // the streamed consult thinking was persisted and sanitized (ANSI + control
    // bytes stripped by the backend; the HTML-looking text survives as text)
    const consultReasoning = reasoningEvents.find((event) => event.kind === 'consult')
    assert.ok(consultReasoning, 'no reasoning record for the senior consult call')
    assert.equal(consultReasoning.role, 'senior')
    assert.equal(consultReasoning.truncated, false, 'the short consult reasoning is not clipped')
    assert.ok(
      consultReasoning.text.includes(HTML_PROBE),
      'the streamed reasoning text was not persisted',
    )
    assert.ok(!consultReasoning.text.includes('\u001b'), 'ANSI escapes must be stripped')
    assert.ok(
      !/[\u0000-\u0008\u000b-\u001f]/.test(consultReasoning.text),
      'control bytes must be stripped',
    )
    // the over-long proposal thinking was bounded head+tail and flagged
    const boundedReasoning = reasoningEvents.find((event) => event.kind === 'proposal')
    assert.ok(boundedReasoning, 'no reasoning record for the junior proposal call')
    assert.equal(boundedReasoning.role, 'junior')
    assert.equal(
      boundedReasoning.truncated,
      true,
      'the over-long reasoning must be flagged truncated',
    )
    assert.ok(
      boundedReasoning.text.includes(LONG_HEAD) && boundedReasoning.text.includes(LONG_TAIL),
      'the bounded record must keep its head and tail',
    )
    assert.match(
      boundedReasoning.text,
      /\[truncated \d+ chars\]/,
      'the bounded record must carry the documented truncation marker',
    )
    assert.ok(
      boundedReasoning.text.length <= 10_200,
      `the persisted reasoning must stay bounded (got ${boundedReasoning.text.length} chars)`,
    )

    // -- 2. a plain reply (JSON fixture path, no thinking deltas) persists none
    await createSession(page, PLAIN_SESSION)
    await sendTask(page, PLAIN_TASK)
    await waitForRunEnd(page)
    const plainEvents = await waitFor(
      async () => {
        const events = await runtimeEventsOf(PLAIN_SESSION)
        return events.some((event) => event.type === 'run_end') ? events : null
      },
      { desc: 'the plain session runtime sidecar to reach run_end' },
    )
    assert.equal(
      plainEvents.filter((event) => event.type === 'reasoning').length,
      0,
      'a non-streaming/plain reply must persist no reasoning record',
    )

    // -- 3. reload: persisted records replay as collapsed disclosure rows -----
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    const reasoningItem = page.locator('.session-item', { hasText: REASONING_SESSION }).first()
    await reasoningItem.waitFor({ timeout: 10000 })
    await reasoningItem.click()
    await page.locator('.chat-scroll').waitFor({ state: 'visible' })
    const rows = page.locator('.reasoning-row')
    await waitFor(async () => (await rows.count()) === reasoningEvents.length, {
      desc: `${reasoningEvents.length} replayed reasoning rows after the reload`,
    })
    for (let index = 0; index < reasoningEvents.length; index += 1) {
      const row = rows.nth(index)
      const head = row.locator('button.stream-thinking-head')
      const label = (await row.locator('.stream-thinking-label').innerText())
        .replace(/\s+/g, ' ')
        .trim()
      assert.ok(
        label.startsWith('Thinking · replayed'),
        `unexpected replayed-row label: ${label}`,
      )
      assert.match(label, /(Senior|Junior)$/, `the replayed row must name its role: ${label}`)
      assert.equal(
        await head.getAttribute('aria-expanded'),
        'false',
        'a replayed reasoning row starts collapsed',
      )
      const body = row.locator('.stream-thinking-body')
      assert.equal(await body.isVisible(), false, 'a collapsed reasoning body is hidden')
      assert.equal(
        await body.getAttribute('id'),
        await head.getAttribute('aria-controls'),
        'the disclosure aria-controls must point at its body',
      )
    }

    // locate the two scripted records by their distinctive text
    const bodyTexts = []
    for (let index = 0; index < reasoningEvents.length; index += 1) {
      bodyTexts.push((await rows.nth(index).locator('.stream-thinking-body').textContent()) ?? '')
    }
    const htmlRowIndex = bodyTexts.findIndex((text) => text.includes(HTML_PROBE))
    const clippedRowIndex = bodyTexts.findIndex((text) => text.includes(LONG_HEAD))
    assert.ok(htmlRowIndex >= 0, 'no replayed row carries the persisted consult reasoning')
    assert.ok(clippedRowIndex >= 0, 'no replayed row carries the bounded long reasoning')

    // expanding is plain text only: Vue escapes the literal markup, no node or
    // handler can be created by reasoning content
    const htmlRow = rows.nth(htmlRowIndex)
    assert.equal(
      await htmlRow.locator('.stream-clipped').count(),
      0,
      'short reasoning is not marked clipped',
    )
    const htmlHead = htmlRow.locator('button.stream-thinking-head')
    await htmlHead.click()
    assert.equal(await htmlHead.getAttribute('aria-expanded'), 'true', 'the row expands')
    const htmlBody = htmlRow.locator('.stream-thinking-body')
    await htmlBody.waitFor({ state: 'visible' })
    const htmlText = await htmlBody.innerText()
    assert.ok(
      htmlText.includes(HTML_PROBE),
      `the expanded row must show the persisted reasoning: ${htmlText}`,
    )
    assert.ok(
      htmlText.includes('<img src=x onerror='),
      'HTML-looking reasoning must stay literal text',
    )
    const htmlMarkup = await htmlBody.evaluate((el) => el.innerHTML)
    assert.ok(htmlMarkup.includes('&lt;img src=x'), 'the reasoning body must be escaped text')
    assert.equal(await htmlRow.locator('img').count(), 0, 'reasoning must never create a DOM node')
    assert.equal(
      await page.evaluate(() => window.__e2e_reasoning_pwned ?? null),
      null,
      'no injected handler may run',
    )

    // the over-long record is clipped with the documented honest marker
    const clippedRow = rows.nth(clippedRowIndex)
    const clippedNote = clippedRow.locator('.stream-clipped')
    await clippedNote.waitFor({ state: 'visible' })
    assert.equal((await clippedNote.innerText()).trim(), CLIPPED_COPY)
    const clippedHead = clippedRow.locator('button.stream-thinking-head')
    await clippedHead.click()
    assert.equal(await clippedHead.getAttribute('aria-expanded'), 'true')
    const clippedBody = clippedRow.locator('.stream-thinking-body')
    await clippedBody.waitFor({ state: 'visible' })
    const clippedText = await clippedBody.innerText()
    assert.ok(
      clippedText.includes(LONG_HEAD) && clippedText.includes(LONG_TAIL),
      'the replayed bounded text keeps its head and tail',
    )
    assert.match(
      clippedText,
      /\[truncated \d+ chars\]/,
      'the replayed text carries the truncation marker',
    )
    assert.ok(
      clippedText.length < 11_000,
      `the replayed reasoning must stay bounded (got ${clippedText.length} chars)`,
    )

    // -- 4. a session without reasoning events renders no replay row ----------
    const plainItem = page.locator('.session-item', { hasText: PLAIN_SESSION }).first()
    await plainItem.click()
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === PLAIN_SESSION,
      { desc: 'the plain session to load after the reload' },
    )
    await waitFor(async () => (await page.locator('.reasoning-row').count()) === 0, {
      desc: 'no replayed reasoning row for a session without reasoning events',
    })

    consoleGuard.assertClean()
    runner.pass('reasoning-replay')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(be.dir)
  }
}

// -- scenario: cooperation surfaces (fork / rewind / undo / steering) -----------------
//
// One scripted fixture process covers the wave-23 operator surfaces that have
// server and web-unit coverage but no browser scenario:
//
//   undo       run 1 writes `e2e-undo-marker.txt` through the real approval
//              broker; "Undo file changes…" previews it as a file the run
//              created and applying the preview deletes it;
//   fork       the session row's "Fork session…" copies the whole two-turn
//              conversation into a new row, opens it, and leaves the source
//              session file byte-identical;
//   rewind     the fork's second operator bubble opens the destructive
//              confirmation; applying it drops that turn (and everything
//              after it) from both the visible transcript and the session file;
//   steering   a slow, still-running work run exposes "Steer run"; a rejected
//              POST keeps the draft intact, an accepted Alt+Enter POST clears
//              it and reports the honest "queued for the next step" notice.
//
// Every applied surface is asserted through both the UI and the persisted API
// state, and the steer acceptance is the backend's real 200 (the one synthetic
// response is the deliberate 409 that proves a rejected draft is preserved).
async function scenarioCooperationSurfaces(runner) {
  const SESSION = 'E2E cooperation surfaces'
  const FORK_TITLE = `${SESSION} (fork)`
  const FIRST_TASK = 'Write the cooperation undo marker'
  const SECOND_TASK = 'Second cooperation turn for the rewind'
  const STEER_SESSION = 'E2E cooperation steering'
  const STEER_TASK = 'Slow cooperation task e2e-steer'
  const STEER_TEXT = 'Steer toward the safer migration path'
  const STEER_REJECT_DETAIL =
    "steering queue is full (8 pending); retry after the run's next step"
  const MARKER_FILE = 'e2e-undo-marker.txt'
  const be = await startBackend({ kind: 'fixture', scenario: 'cooperation', lingerMs: 30000 })
  const wsDir = tmpDir('tb-e2e-ws-coop')
  const wsName = path.basename(wsDir)
  const markerPath = path.join(wsDir, MARKER_FILE)
  const { context, page, consoleGuard } = await newScenarioPage()

  const getJson = async (pathname) => {
    const res = await fetch(`${be.base}${pathname}`)
    assert.equal(res.status, 200, `GET ${pathname} -> HTTP ${res.status}`)
    return res.json()
  }
  const sessionDetail = (name) => getJson(`/api/sessions/${encodeURIComponent(name)}`)
  /** The session's real operator tasks (the backend's rewind boundary rule). */
  const operatorTurns = (events) =>
    (Array.isArray(events) ? events : []).filter(
      (event) =>
        event?.from === 'user' &&
        event?.to === 'senior' &&
        event?.kind === 'message' &&
        typeof event.payload?.text === 'string' &&
        event.payload.text.trim() !== '',
    )
  const rowWithTitle = (title) =>
    page.locator('.session-row').filter({
      has: page.locator(`.session-title:text-is("${title}")`),
    })
  /** The one open AppDialog, asserted by its visible title. */
  const openDialog = async (title) => {
    const dialog = page.locator('.app-dialog')
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(
      (await dialog.locator('.app-dialog__title').innerText()).trim(),
      title,
      'unexpected dialog title',
    )
    return dialog
  }

  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)
    await createSession(page, SESSION)
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === SESSION,
      { desc: 'the cooperation session to be selected' },
    )

    const sourceName = await sessionNameByTitle(be.base, SESSION)

    // -- run 1: a real approval, then the run-created file --------------------
    await sendTask(page, FIRST_TASK, { mode: 'work' })
    const approvalDock = page.locator('.approval-dock')
    await approvalDock.waitFor({ state: 'visible', timeout: 30000 })
    await approvalDock.locator('button.approval-btn', { hasText: 'Allow once' }).click()
    await waitForRunEnd(page)
    await waitFor(() => fs.existsSync(markerPath), {
      desc: 'the scripted run to write the marker file',
    })

    // -- run-scoped undo: preview the created file, apply, file is gone ------
    // Wait for the real preview route before clicking: the run's undo capture
    // closes in the run's finally, so the UI bar and the persisted record can
    // settle a moment apart. The UI must then show exactly that preview.
    const completedRunId = await waitFor(
      async () => {
        const runs = await getJson(`/api/runs?session=${encodeURIComponent(sourceName)}`)
        const completed = runs.find((run) => run.status === 'completed')
        if (!completed) return null
        const res = await fetch(
          `${be.base}/api/sessions/${encodeURIComponent(sourceName)}/undo/${encodeURIComponent(completed.run_id)}`,
        )
        return res.ok ? completed.run_id : null
      },
      { desc: 'the completed write run and its undo preview' },
    )

    const undoBar = page.locator('.run-undo-bar')
    await undoBar.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await undoBar.getAttribute('aria-label'), "Undo this run's file changes")
    assert.equal(
      (await undoBar.locator('button.run-undo-open').innerText()).trim(),
      'Undo file changes…',
    )
    await undoBar.locator('button.run-undo-open').click()

    const undoDialog = await openDialog("Undo this run's file changes")
    const undoDescription = (await undoDialog.locator('.app-dialog__description').innerText()).trim()
    assert.ok(
      undoDescription.includes(`Run ${completedRunId}`) && undoDescription.includes(sourceName),
      `the undo dialog must name its run and session (got "${undoDescription}")`,
    )
    assert.equal(
      (await undoDialog.locator('.run-undo-head').innerText()).trim(),
      '1 of 1 recorded file can be undone now.',
    )
    const previewRows = undoDialog.locator('.run-undo-row')
    assert.equal(await previewRows.count(), 1, 'the preview must list only the run-created file')
    assert.equal(
      (await previewRows.locator('.run-undo-path').innerText()).trim(),
      MARKER_FILE,
    )
    assert.equal(
      (await previewRows.locator('.run-undo-what').innerText()).trim(),
      'Delete the file the run created',
    )

    const applyUndo = undoDialog.locator('button.undo-apply')
    assert.equal(await applyUndo.isDisabled(), false, 'the created file must be undoable')
    assert.equal((await applyUndo.innerText()).trim(), 'Undo 1 file')
    await applyUndo.click()
    await waitFor(() => !fs.existsSync(markerPath), {
      desc: 'applying the undo to delete the file the run created',
    })
    await waitFor(
      async () =>
        (await undoDialog.locator('.run-undo-head[role="status"]').innerText()).trim() ===
        'Undo applied: 1 file restored.',
      { desc: 'the honest undo apply summary' },
    )
    const appliedRows = undoDialog.locator(
      'section[aria-label="Restored or deleted"] .run-undo-row',
    )
    assert.equal(await appliedRows.count(), 1)
    assert.equal((await appliedRows.locator('.run-undo-what').innerText()).trim(), 'deleted')
    await page
      .locator('.command-notice', { hasText: 'Undo applied: 1 file restored.' })
      .waitFor({ timeout: 10000 })
    await undoDialog.locator('button.undo-cancel').click()
    await undoDialog.waitFor({ state: 'hidden' })

    // -- run 2: a second operator turn (no file mutation, no approval) --------
    await sendTask(page, SECOND_TASK, { mode: 'work' })
    await waitForRunEnd(page)
    await waitFor(
      async () => (await page.locator('.chat-group.side-operator').count()) === 2,
      { desc: 'the second operator turn in the transcript' },
    )
    const transcriptBeforeFork = await page.locator('.chat-scroll').innerText()
    assert.ok(transcriptBeforeFork.includes(FIRST_TASK))
    assert.ok(transcriptBeforeFork.includes(SECOND_TASK))
    const sourceDetail = await waitFor(
      async () => {
        const detail = await sessionDetail(sourceName)
        return operatorTurns(detail.events).length === 2 ? detail : null
      },
      { desc: 'two persisted operator turns before forking' },
    )
    const sourceBytesBefore = fs.readFileSync(path.join(be.dir, sourceName), 'utf-8')

    // The fork has no workspace link (copied lineage only), so clear the
    // filter first or the refreshed sidebar would hide the new row. Select by
    // value: the option's visible label is "All workspaces".
    const workspaceFilter = page.locator('select[title="Filter sessions by workspace"]')
    await workspaceFilter.selectOption('all')
    await waitFor(async () => (await workspaceFilter.inputValue()) === 'all', {
      desc: 'the unfiltered session list',
    })
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === SESSION,
      { desc: 'the source session to stay selected while clearing the filter' },
    )

    // -- fork: a new row, opened, both turns copied, source byte-identical ----
    // Open through the keyboard path: the trigger is revealed on row hover and
    // the full-width select button wins the pointer hit-test in headless Edge,
    // so a pointer click is not a reliable way to reach it (the real keyboard
    // path is ArrowDown on the focused trigger).
    const sourceMenuTrigger = rowWithTitle(SESSION).locator('.row-menu-trigger')
    await sourceMenuTrigger.focus()
    await page.keyboard.press('ArrowDown')
    const rowMenu = page.locator('.row-menu')
    await rowMenu.waitFor({ state: 'visible' })
    const forkItem = rowMenu.locator('button[data-menu-action="fork"]')
    await waitFor(async () => !(await forkItem.isDisabled()), {
      desc: 'forking to be offered on the quiescent session row',
    })
    await forkItem.click()
    // The session row reports through the app's naive-ui message provider
    // (`.n-message`), unlike the shell's own `.command-notice` notices.
    const forkMessage = page.locator('.n-message', { hasText: 'Forked from' })
    await forkMessage.waitFor({ timeout: 10000 })
    const forkNotice = (await forkMessage.innerText()).trim()
    assert.ok(
      forkNotice.includes('the original session is untouched'),
      `the fork notice must state the source is untouched (got "${forkNotice}")`,
    )
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === FORK_TITLE,
      { desc: 'the fork to open in the conversation view' },
    )
    await waitFor(async () => (await rowWithTitle(FORK_TITLE).count()) === 1, {
      desc: 'the fork session row in the sidebar',
    })
    const forkName = await sessionNameByTitle(be.base, FORK_TITLE)
    const forkDetail = await sessionDetail(forkName)
    assert.equal(operatorTurns(forkDetail.events).length, 2, 'the fork must copy both turns')
    assert.equal(
      forkDetail.events.length,
      sourceDetail.events.length,
      'the whole-conversation fork must copy every envelope',
    )
    const forkTranscript = await page.locator('.chat-scroll').innerText()
    assert.ok(forkTranscript.includes(FIRST_TASK) && forkTranscript.includes(SECOND_TASK))

    const sourceBytesAfter = fs.readFileSync(path.join(be.dir, sourceName), 'utf-8')
    assert.equal(
      sourceBytesAfter,
      sourceBytesBefore,
      'forking must leave the source session file byte-identical',
    )
    assert.deepEqual(
      (await sessionDetail(sourceName)).events,
      sourceDetail.events,
      'forking must not change the source conversation API view',
    )

    // The source itself still renders both turns; the fork is independent.
    await rowWithTitle(SESSION).locator('.session-item').click()
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === SESSION,
      { desc: 'the source session to reopen' },
    )
    await waitFor(
      async () => (await page.locator('.chat-group.side-operator').count()) === 2,
      { desc: 'the source conversation to keep both turns' },
    )
    await rowWithTitle(FORK_TITLE).locator('.session-item').click()
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === FORK_TITLE,
      { desc: 'the fork to be selected again' },
    )
    await waitFor(
      async () => (await page.locator('.chat-group.side-operator').count()) === 2,
      { desc: 'the fork conversation to render both turns' },
    )

    // -- rewind: the second turn and everything after it disappear -----------
    const secondTurn = page
      .locator('.chat-group.side-operator')
      .filter({ hasText: SECOND_TASK })
    await secondTurn.waitFor({ state: 'visible' })
    await secondTurn.hover()
    const rewindButton = secondTurn.locator('button.bubble-rewind')
    await rewindButton.waitFor({ state: 'visible' })
    await waitFor(async () => !(await rewindButton.isDisabled()), {
      desc: 'the completed turn to become rewindable',
    })
    await rewindButton.click()
    const rewindDialog = await openDialog('Rewind conversation to here?')
    const rewindCopy = (await rewindDialog.locator('.rewind-copy').innerText()).trim()
    assert.match(rewindCopy, /Remove this task and everything after it:/)
    assert.match(rewindCopy, /1 operator task/)
    assert.ok(rewindCopy.includes('cannot be undone'))
    assert.ok(
      (await rewindDialog.locator('.rewind-selected').innerText()).includes(SECOND_TASK),
      'the confirmation must quote the selected task',
    )
    await rewindDialog.locator('button.rewind-confirm').click()
    const rewindNotice = page.locator('.command-notice', { hasText: 'Rewound:' })
    await rewindNotice.waitFor({ timeout: 10000 })
    assert.match(
      (await rewindNotice.innerText()).trim(),
      /Rewound: \d+ messages? removed \(1 task\), \d+ kept\./,
      'the rewind notice must report the applied cut honestly',
    )
    await waitFor(
      async () => {
        const text = await page.locator('.chat-scroll').innerText()
        return text.includes(FIRST_TASK) && !text.includes(SECOND_TASK)
      },
      { desc: 'the removed turn to disappear while the kept turn stays visible' },
    )
    await waitFor(
      async () => (await page.locator('.chat-group.side-operator').count()) === 1,
      { desc: 'one operator turn in the rewritten transcript' },
    )
    const forkAfterRewind = await waitFor(
      async () => {
        const detail = await sessionDetail(forkName)
        return operatorTurns(detail.events).length === 1 ? detail : null
      },
      { desc: 'one persisted operator turn after the rewind' },
    )
    assert.ok(
      forkAfterRewind.events.length < forkDetail.events.length,
      'rewind must shorten the persisted session',
    )

    // -- steering: rejection keeps the draft, acceptance clears it -----------
    await createSession(page, STEER_SESSION)
    await waitFor(
      async () => (await page.locator('.chat-title').innerText()).trim() === STEER_SESSION,
      { desc: 'the steering session to be selected' },
    )
    await sendTask(page, STEER_TASK, { mode: 'work' })
    const steerButton = page.locator('button.composer-steer')
    await steerButton.waitFor({ state: 'visible', timeout: 30000 })
    assert.match(
      (await steerButton.getAttribute('title')) ?? '',
      /next step/,
      'the steer control must say where the text lands',
    )
    const composerInput = page.locator('textarea.composer-input')
    await composerInput.fill(STEER_TEXT)
    await waitFor(async () => !(await steerButton.isDisabled()), {
      desc: 'the steer action to enable for a non-empty draft',
    })

    let steerPosts = 0
    let rejectNextSteer = true
    await page.route('**/api/runs/*/steer', async (route) => {
      steerPosts += 1
      if (rejectNextSteer) {
        rejectNextSteer = false
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ detail: STEER_REJECT_DETAIL }),
        })
        return
      }
      await route.continue()
    })

    // A rejected POST is a real request that the UI must not treat as accepted.
    await steerButton.click()
    await page
      .locator('.toast', { hasText: STEER_REJECT_DETAIL })
      .first()
      .waitFor({ timeout: 10000 })
    assert.equal(steerPosts, 1, 'the rejected steer must have been POSTed')
    assert.equal(
      await composerInput.inputValue(),
      STEER_TEXT,
      'a rejected steer must keep the operator draft exactly as typed',
    )
    await waitFor(async () => !(await steerButton.isDisabled()), {
      desc: 'the steer action to re-enable after a rejected request',
    })

    // Alt+Enter is the explicit steer gesture; this time the real backend
    // answers 200, so only now may the draft be consumed.
    await composerInput.focus()
    await composerInput.press('Alt+Enter')
    await page
      .locator('.command-notice', { hasText: 'Steer queued' })
      .waitFor({ timeout: 10000 })
    assert.equal(steerPosts, 2, 'the accepted steer must have been POSTed')
    await waitFor(async () => (await composerInput.inputValue()) === '', {
      desc: 'the accepted steer to clear the draft',
    })
    const steerNotice = (await page.locator('.command-notice').innerText()).trim()
    assert.ok(
      steerNotice.includes("applied at the run's next step"),
      `the steer notice must say it is queued, not delivered (got "${steerNotice}")`,
    )

    // Stop the still-lingering run so the process leaves no live work behind.
    await page.locator('form[aria-label="New task"] button:has-text("Stop")').click()
    await page.locator('.toast', { hasText: 'Run stopped' }).first().waitFor({ timeout: 20000 })
    await waitForRunEnd(page)
    const runs = await getJson('/api/runs')
    assert.ok(
      runs.every((run) => !['running', 'queued', 'waiting'].includes(run.status)),
      `backend still reports an active run: ${JSON.stringify(runs.map((run) => run.status))}`,
    )
    await page.unroute('**/api/runs/*/steer')

    // The one synthetic 409 above is deliberate; Chromium logs every rejected
    // fetch as a console error before the app handles it, so allow exactly that
    // resource error and keep every other console/page error fatal.
    consoleGuard.assertClean([/Failed to load resource: the server responded with a status of 409 \(Conflict\)/])
    runner.pass('cooperation-surfaces')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: session-aware tab title (wave 25) ----------------------------------
//
// `web/src/tabTitle.ts` formats `document.title` from the selected session's
// title and live run state; the shell writes it. The scripted `title` fixture
// holds its first senior opening for `--linger-ms`, so the running marker is
// observable deterministically (no sleep), then parks on the real approval
// broker for the waiting marker, and completes for the plain title. The second
// session is left parked on its approval while the operator switches to A, so
// it completes in the background and becomes unread; the selected session keeps
// the plain title, and deleting the open session leaves no selection, which is
// the only state that shows `(N) Two Brothers`.

async function scenarioTabTitle(runner) {
  const SESSION_A = 'E2E tab title'
  const SESSION_B = 'E2E tab unread'
  const be = await startBackend({ kind: 'fixture', scenario: 'title', lingerMs: 1500 })
  const wsDir = tmpDir('tb-e2e-ws-title')
  const wsName = path.basename(wsDir)
  const { context, page, consoleGuard } = await newScenarioPage()

  const documentTitle = async () => (await page.title()).trim()
  const plainTitle = (name) => `${name} — Two Brothers`
  const waitTitle = (expected, desc) =>
    waitFor(async () => (await documentTitle()) === expected, { timeout: 20000, desc })
  const waitTitlePrefix = (prefix, desc) =>
    waitFor(async () => (await documentTitle()).startsWith(prefix), { timeout: 20000, desc })
  const rowWithTitle = (name) =>
    page.locator('.session-row').filter({
      has: page.locator(`.session-title:text-is("${name}")`),
    })

  /** One scripted run: plain → ▶ running → ! waiting → plain after the decision. */
  const observeTitleCycle = async (name) => {
    await waitTitle(plainTitle(name), `the plain title of "${name}" before its run`)
    await sendTask(page, `${TASK_TEXT} e2e-title`, { mode: 'work' })
    await waitTitlePrefix(`▶ ${name} — Two Brothers`, `the running title of "${name}"`)
    const approvalDock = page.locator('.approval-dock')
    await approvalDock.waitFor({ state: 'visible', timeout: 30000 })
    await waitTitle(`! ${name} — Two Brothers`, `the waiting title of "${name}"`)
    await approvalDock.locator('button.approval-btn', { hasText: 'Allow once' }).click()
    await waitForRunEnd(page)
    await waitTitle(plainTitle(name), `the plain title after "${name}" completes`)
  }

  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    await ensureWorkspace(page, wsDir, wsName)
    await selectWorkspaceFilter(page, wsName)

    await createSession(page, SESSION_A)
    await observeTitleCycle(SESSION_A)

    // B runs while it is selected (so its own markers are observable), but the
    // operator leaves it parked on the approval and opens A. The run then
    // finishes in the background — the only way a completed run becomes unread.
    await createSession(page, SESSION_B)
    const nameB = await sessionNameByTitle(be.base, SESSION_B)
    await waitTitle(plainTitle(SESSION_B), 'the plain title of B before its run')
    await sendTask(page, `${TASK_TEXT} e2e-title`, { mode: 'work' })
    await waitTitlePrefix(`▶ ${SESSION_B} — Two Brothers`, 'the running title of B')
    const dockB = page.locator('.approval-dock')
    await dockB.waitFor({ state: 'visible', timeout: 30000 })
    await waitTitle(`! ${SESSION_B} — Two Brothers`, 'the waiting title of B')

    await rowWithTitle(SESSION_A).locator('.session-item').click()
    await waitTitle(plainTitle(SESSION_A), 'the plain title of the selected session A')

    // Answer B's parked approval through the backend API (the UI allow path is
    // exercised by A's cycle above) so B can complete while A is on screen.
    const waitingRun = (await (await fetch(`${be.base}/api/runs`)).json()).find(
      (run) => run.session === nameB && run.status === 'waiting',
    )
    assert.ok(waitingRun, `session B has no waiting run (got ${nameB})`)
    const pendingRes = await fetch(`${be.base}/api/runs/${waitingRun.run_id}/approvals`)
    assert.equal(pendingRes.status, 200, `GET approvals -> HTTP ${pendingRes.status}`)
    const pending = (await pendingRes.json()).pending
    assert.equal(pending.length, 1, 'B must have exactly one pending approval')
    const answered = await fetch(
      `${be.base}/api/runs/${waitingRun.run_id}/approvals/${pending[0].approval_id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allow: true, scope: 'once' }),
      },
    )
    assert.equal(answered.status, 200, `POST approval -> HTTP ${answered.status}`)
    await waitFor(
      async () =>
        (await (await fetch(`${be.base}/api/runs/${waitingRun.run_id}`)).json()).status ===
        'completed',
      { timeout: 30000, desc: 'the background B run to complete' },
    )

    // B is now unread, but the selected session's plain title wins over the count.
    await waitFor(
      async () =>
        (await rowWithTitle(SESSION_B)
          .locator('.session-status[aria-label="Unread run result in this session"]')
          .count()) === 1,
      { timeout: 20000, desc: 'session B to report its unread run' },
    )
    assert.equal(
      await documentTitle(),
      plainTitle(SESSION_A),
      'a selected session title must never carry the unread count',
    )

    // Deleting the open session leaves no selection: only then may the count
    // appear in the document title.
    const trigger = rowWithTitle(SESSION_A).locator('.row-menu-trigger')
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    const rowMenu = page.locator('.row-menu')
    await rowMenu.waitFor({ state: 'visible' })
    await rowMenu.locator('button[data-menu-action="delete"]').click()
    await rowMenu.locator('button[aria-label="Confirm delete session"]').click()
    await waitFor(async () => (await rowWithTitle(SESSION_A).count()) === 0, {
      desc: 'session A to be deleted',
    })
    await waitTitle('(1) Two Brothers', 'the unread count with no session selected')
    assert.equal(
      (await page.locator('.chat-title').innerText()).trim(),
      'Two Brothers',
      'the shell header falls back to the product name with no session selected',
    )

    // Opening the unread session consumes it and the plain session title returns.
    await rowWithTitle(SESSION_B).locator('.session-item').click()
    await waitTitle(plainTitle(SESSION_B), 'the plain title of the reopened session B')
    await waitFor(
      async () =>
        (await rowWithTitle(SESSION_B)
          .locator('.session-status[aria-label="Unread run result in this session"]')
          .count()) === 0,
      { desc: 'opening session B to consume its unread state' },
    )

    consoleGuard.assertClean()
    runner.pass('tab-title')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
    rmTree(wsDir)
    rmTree(be.dir)
  }
}

// -- scenario: Settings -> Advanced auto-compaction (wave 25) ---------------------
//
// The card edits the server's persisted run-level context budgets (the
// `compaction` section of sessions/settings.json). The backend here is the real
// TypeScript server, so /api/settings persistence is real and offline: strict
// validation blocks a bad value before any PUT, a valid save persists the
// section, and the values plus their honest effective/source lines survive a
// page reload.

async function scenarioSettingsAdvanced(runner) {
  const be = await startBackend({ kind: 'mock' })
  const { context, page, consoleGuard } = await newScenarioPage()
  const COMPACTION_KEYS = [
    'threshold_chars',
    'threshold_tokens',
    'keep_recent_chars',
    'context_window',
  ]
  const puts = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') {
      puts.push(request.postData() ?? '')
    }
  })
  const getSettings = async () => {
    const res = await fetch(`${be.base}/api/settings`)
    assert.equal(res.status, 200, `GET /api/settings -> HTTP ${res.status}`)
    return res.json()
  }
  const openAdvanced = async () => {
    await page.locator('.sidebar-footer .footer-action').click()
    const dialog = page.locator('[role="dialog"][aria-labelledby="settings-dialog-title"]')
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: 'Advanced', exact: true }).click()
    const pane = dialog.locator('[role="region"][aria-label="Advanced"]')
    await pane.waitFor({ state: 'visible' })
    await pane.locator('#advanced-compaction-heading').waitFor({ state: 'visible' })
    return { dialog, pane }
  }
  const saveButton = (dialog) =>
    dialog.locator('.settings-footer-actions button.n-button--primary-type').first()

  try {
    await page.goto(be.base)
    await page.locator('nav[aria-label="Sessions"]').waitFor()

    const { dialog, pane } = await openAdvanced()
    assert.equal(
      (await pane.locator('#advanced-compaction-heading').innerText()).trim(),
      'Auto-compaction',
    )
    // The card renders its heading before GET /api/settings resolves; wait for
    // the first real input so allInnerTexts() cannot race the async load.
    await pane.locator('#compaction-threshold_chars').waitFor({ state: 'visible' })
    const labels = (await pane.locator('.compaction-field label').allInnerTexts()).map((text) =>
      text.trim(),
    )
    assert.deepEqual(labels, [
      'Threshold (chars)',
      'Threshold (tokens)',
      'Keep recent (chars)',
      'Context window (tokens)',
    ])
    for (const key of COMPACTION_KEYS) {
      const input = pane.locator(`#compaction-${key}`)
      assert.equal(await input.getAttribute('type'), 'number', `${key} is a number input`)
      assert.equal(await input.getAttribute('min'), '0', `${key} rejects negatives by its floor`)
      assert.equal(
        await input.getAttribute('aria-describedby'),
        `compaction-${key}-effective`,
        `${key} is described by its effective-value line`,
      )
      assert.match(
        await pane.locator(`#compaction-${key}-effective`).innerText(),
        /^Effective: /,
        `${key} shows its effective value and source`,
      )
    }
    assert.equal(
      (await pane.locator('#compaction-threshold_chars-effective').innerText()).trim(),
      'Effective: not configured',
      'nothing is persisted yet, so the first budget is honestly not configured',
    )

    // Native constraint validation already refuses a negative budget: the
    // number input's floor makes the form invalid, so the browser blocks the
    // submit before the app's own handler runs and nothing is PUT. The app's
    // strict parser must still catch values the browser accepts, so the next
    // step uses `1e3` (native-valid, not a plain whole number).
    const threshold = pane.locator('#compaction-threshold_chars')
    await threshold.fill('-5')
    assert.equal(
      await threshold.evaluate((el) => el.checkValidity()),
      false,
      'the number input natively rejects a negative budget',
    )
    await saveButton(dialog).click()
    assert.equal(puts.length, 0, 'the native negative rejection must not send a PUT')
    assert.equal(await dialog.isVisible(), true, 'the blocked save leaves Settings open')

    // Strict app validation: a native-valid but non-whole value is an inline
    // `role=alert` on the field plus the footer alert, and blocks the save
    // before any PUT reaches the backend.
    await threshold.fill('1e3')
    await saveButton(dialog).click()
    const fieldError = pane.locator('.compaction-error[role="alert"]')
    await fieldError.waitFor({ state: 'visible' })
    assert.equal(
      (await fieldError.innerText()).trim(),
      'Enter a whole number of 0 or more (0 = off/unknown).',
    )
    assert.equal(
      await pane.locator('#compaction-threshold_chars').getAttribute('aria-invalid'),
      'true',
      'the rejected input is marked invalid for assistive tech',
    )
    const footerError = dialog.locator('.settings-footer-error[role="alert"]')
    await footerError.waitFor({ state: 'visible' })
    assert.equal(
      (await footerError.innerText()).trim(),
      'Fix the highlighted auto-compaction values before saving.',
    )
    assert.equal(puts.length, 0, 'the invalid form must not send PUT /api/settings')

    // A corrected form saves through the dialog's single Save action.
    await pane.locator('#compaction-threshold_chars').fill('64000')
    await pane.locator('#compaction-keep_recent_chars').fill('8000')
    assert.equal(
      await pane.locator('.compaction-error').count(),
      0,
      'editing the field clears its inline error',
    )
    await saveButton(dialog).click()
    await dialog.waitFor({ state: 'hidden', timeout: 15000 })
    const saved = await getSettings()
    assert.equal(puts.length, 1, 'only the valid save may reach PUT /api/settings')
    assert.match(puts[0], /"compaction"/, 'the save carries the compaction section')
    assert.equal(saved.compaction.threshold_chars.persisted, 64000)
    assert.equal(saved.compaction.threshold_chars.effective, 64000)
    assert.equal(saved.compaction.threshold_chars.source, 'persisted')
    assert.equal(saved.compaction.keep_recent_chars.persisted, 8000)
    assert.equal(saved.compaction.threshold_tokens.persisted, 0)
    assert.equal(saved.compaction.context_window.persisted, 0)
    const onDisk = JSON.parse(fs.readFileSync(path.join(be.dir, 'settings.json'), 'utf-8'))
    assert.deepEqual(
      onDisk.compaction,
      { threshold_chars: 64000, threshold_tokens: 0, keep_recent_chars: 8000, context_window: 0 },
      'sessions/settings.json persists the four budgets (zeros stay 0)',
    )

    // Reload: the persisted budgets seed the form and their effective lines.
    await page.reload()
    await page.locator('nav[aria-label="Sessions"]').waitFor()
    const reopened = await openAdvanced()
    assert.equal(await reopened.pane.locator('#compaction-threshold_chars').inputValue(), '64000')
    assert.equal(await reopened.pane.locator('#compaction-keep_recent_chars').inputValue(), '8000')
    assert.equal(
      (await reopened.pane.locator('#compaction-threshold_chars-effective').innerText()).trim(),
      'Effective: 64000',
    )
    assert.equal(
      (await reopened.pane.locator('#compaction-keep_recent_chars-effective').innerText()).trim(),
      'Effective: 8000',
    )
    for (const key of ['threshold_tokens', 'context_window']) {
      assert.equal(
        (await reopened.pane.locator(`#compaction-${key}-effective`).innerText()).trim(),
        'Effective: not configured',
        `${key} keeps its honest not-configured line`,
      )
    }
    await reopened.dialog.getByRole('button', { name: 'Close settings' }).click()
    await reopened.dialog.waitFor({ state: 'hidden' })

    consoleGuard.assertClean()
    runner.pass('settings-advanced')
  } finally {
    await context.close().catch(() => {})
    await killBackend(be)
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
        label: 'appearance-accent',
        run: () => (
          (currentRunner = makeRunner('appearance-accent')),
          scenarioAppearanceAccent(currentRunner)
        ),
      },
      {
        label: 'appearance-roles',
        run: () => (
          (currentRunner = makeRunner('appearance-roles')),
          scenarioAppearanceRoles(currentRunner)
        ),
      },
      {
        label: 'keybindings',
        run: () => (
          (currentRunner = makeRunner('keybindings')),
          scenarioKeybindings(currentRunner)
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
      {
        label: 'tool-preview',
        run: () => (
          (currentRunner = makeRunner('tool-preview')),
          scenarioToolPreview(currentRunner)
        ),
      },
      {
        label: 'workspace-drag',
        run: () => (
          (currentRunner = makeRunner('workspace-drag')),
          scenarioWorkspaceDrag(currentRunner)
        ),
      },
      {
        label: 'reasoning-replay',
        run: () => (
          (currentRunner = makeRunner('reasoning-replay')),
          scenarioReasoningReplay(currentRunner)
        ),
      },
      {
        label: 'cooperation-surfaces',
        run: () => (
          (currentRunner = makeRunner('cooperation-surfaces')),
          scenarioCooperationSurfaces(currentRunner)
        ),
      },
      {
        label: 'tab-title',
        run: () => (
          (currentRunner = makeRunner('tab-title')),
          scenarioTabTitle(currentRunner)
        ),
      },
      {
        label: 'settings-advanced',
        run: () => (
          (currentRunner = makeRunner('settings-advanced')),
          scenarioSettingsAdvanced(currentRunner)
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
      'appearance-accent',
      'appearance-roles',
      'keybindings',
      'provider-reset',
      'folding',
      'plan-dock',
      'composer-seats',
      'hero-starters',
      'composer-recall',
      'approval-reason',
      'tool-preview',
      'workspace-drag',
      'reasoning-replay',
      'cooperation-surfaces',
      'tab-title',
      'settings-advanced',
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
