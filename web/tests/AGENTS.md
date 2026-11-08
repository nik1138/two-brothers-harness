# AGENTS.md — `web/tests/`

Local map for the web unit tests. Parent rules: `../AGENTS.md`; root rules:
`../../AGENTS.md`.

## What lives here

- `*.test.ts` — plain `node:test` suites for the pure projection/model
  modules in `../src/` (no DOM, no browser).
- `register-ts.mjs` — the test bootstrap that registers the TypeScript
  resolve hook.
- `ts-resolve-hook.mjs` — extensionless-import resolution for the sources.

## Boundaries

- Hermetic and offline: no backend, no network, no Playwright. Browser E2E
  lives in `../../e2e/`.
- Test pure modules here; component/DOM behavior belongs in the browser E2E
  suite. `npm run build` (vue-tsc) covers `.vue` type checking.
- Do not weaken assertions to make a lane green; fix the model or escalate.

## Invariants and hazards

- **Register every new suite in `web/package.json` `scripts.test`.** The
  script enumerates test files explicitly; an unlisted file never runs in
  `npm test`, the smoke gate, or CI.
- Use `node --import ./tests/register-ts.mjs --test <files>`; plain
  `node --test` fails on extensionless source imports.
- Tests must not read the real `localStorage`; the model modules take
  injectable storage. Keep them deterministic and date-independent.

## Commands

```powershell
cd web
npm test
node --import ./tests/register-ts.mjs --test tests/drafts.test.ts   # single file
npm run build                                                       # type/template gate
```

Workflow: `../../AGENTS.md` ("Subagent Lanes").
