# AGENTS.md — `e2e/`

Local map for the browser E2E package. Root rules: `../AGENTS.md`; the web
workspace rules are in `../web/AGENTS.md`.

## What lives here

- `run.mjs` — the Playwright runner; each scenario boots the TypeScript
  backend (mock or scripted provider) and drives the system Edge headless.
- `fixtures/` — scripted provider/server fixtures and scenario inputs.
- `web-freshness.mjs` + `web-freshness.test.mjs` — the packaged-web freshness
  guard and its dependency-free unit tests.
- `package.json` / `package-lock.json` — the separate E2E package
  (`playwright` only).

## Boundaries

- This is its own package; do not merge it into `web/` or the harness package.
- Browser E2E is manual/opt-in (rehearsal, release lane), not part of
  `npm test`, the smoke gate, or CI. CI runs only the freshness unit tests.
- `packages/harness/web` is generated; never hand-edit it. Change `web/src`,
  rebuild, and let the runner/freshness guard copy it.
- Do not commit `node_modules/`, browser profiles, or run artifacts.

## Invariants and hazards

- The backend serves the packaged `packages/harness/web` copy **before**
  `web/dist`; a stale copy silently tests old UI. `run.mjs` refreshes it
  through `web-freshness.mjs`; keep that guard green.
- `web/dist` must exist; `scripts/e2e-test.ps1` builds it when missing/stale.
- Scenarios are hermetic unless `TWO_BROTHERS_REAL_E2E=1` (the `real` case).
  Never make a default scenario depend on a model endpoint.
- Exit 0 = all scenarios passed; any failure exits non-zero.

## Commands

```powershell
# from the repo root — builds web when stale, installs deps, runs everything
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1

# or run the suite directly after installing its deps
cd e2e
npm install
node web-freshness.test.mjs
npm test                       # node run.mjs
```

Workflow: `../AGENTS.md` ("Subagent Lanes").
