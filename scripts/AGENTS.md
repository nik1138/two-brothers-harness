# AGENTS.md — `scripts/`

Local map for the repository gates and release tooling. Root rules:
`../AGENTS.md`.

## What lives here

- `smoke-test.ps1` — offline gate: package typecheck/build/tests/selftest,
  mock run, hermetic CLI E2E, fault injection, reference selftest, web tests
  and build.
- `e2e-test.ps1` — browser-E2E wrapper (builds web when stale, installs E2E
  deps, runs `e2e/web-freshness.test.mjs` and `e2e/run.mjs`).
- `release-rehearsal.ps1` — pre-push rehearsal: clean tree, build + dependency
  gate, smoke, tarball smoke, `pack:check`, browser E2E.
- `check-pinned-deps.mjs` — exact-version guard for runtime dependencies.
- `check-runtime-deps.mjs` — phantom-import guard over the built `dist/`.
- `tarball-smoke.mjs` — pack → install into a temp project → consumer smoke.

## Boundaries

- These scripts are the gates. Never weaken, skip, or reorder a check to make
  a lane green; a failing gate is a finding, not a nuisance.
- No product code here. Keep the scripts offline except for the browser E2E's
  local Edge/Playwright and normal npm registry access at install time.
- Windows PowerShell 5.1 only (`pwsh` is not installed here); use the
  documented `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`
  invocation.

## Invariants and hazards

- `smoke-test.ps1` must end with `SMOKE TEST: PASS`; `release-rehearsal.ps1`
  exits 0 only when every planned step passes; `tarball-smoke.mjs` prints
  `TARBALL SMOKE: PASS (7/7)`.
- `check-runtime-deps.mjs` reads `packages/harness/dist/`; build first.
- `tarball-smoke.mjs` packs + installs (slow) and is deliberately not part of
  `npm run check`; run it manually or via the rehearsal.
- The rehearsal tolerates only its own uncommitted script; any other dirty
  tracked/untracked file fails the clean-tree step.

## Commands

```powershell
# from the repo root
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release-rehearsal.ps1
npm run check
npm run check:tarball-smoke
```

Workflow: `../AGENTS.md` ("Subagent Lanes").
