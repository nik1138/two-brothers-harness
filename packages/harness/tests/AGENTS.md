# AGENTS.md — `packages/harness/tests/`

Local map for the package test suite. Parent rules: `../AGENTS.md`; root
project rules: `../../../AGENTS.md`.

## What lives here

- `*.test.ts` — `node:test` suites, one per source area (`server`, `session`,
  `compaction`, `cli`, `tui*`, ...).
- `run-all.ts` — the in-process entry (`npm test`) that imports every suite so
  the runner needs no child-process spawning.
- `fixtures/` — checked-in inputs (MCP configs, scripted provider payloads).
  Keep fixtures small and deterministic.

## Boundaries

- Everything here is hermetic and offline: mock/scripted providers, temp
  dirs, ephemeral loopback ports. Live LM Studio suites belong in `../e2e/`;
  browser E2E belongs in `../../../e2e/`.
- Tests exercise the package sources (`../src/`), not the built `dist/`; the
  `dist` variant is `../e2e/cli.ts --dist`.
- Do not weaken a contract assertion to make a lane pass; fix the source or
  escalate the contract change through `PROTOCOL.md`.

## Invariants and hazards

- **Register every new suite in `run-all.ts`.** `npm test` only runs what
  `run-all.ts` imports; an unregistered file silently never runs there.
  `npm run test:spawn` (`node --test`) discovers `*.test.ts` by itself.
- File names are lowercase module names (`sessionrewind.test.ts`,
  `tuiintegration.test.ts`).
- Use `node:test` + `node:assert/strict`; create temp dirs with `mkdtemp` and
  clean them in `finally`. Never depend on the network, a model endpoint, or
  repository-external state.
- POSIX-only cases must skip explicitly on Windows; CI's ubuntu legs run them.

## Commands

```powershell
cd packages/harness
npm test                                  # in-process run-all.ts
npm run test:spawn                        # node --test discovery
node --test tests/server.test.ts          # single suite
npm run typecheck                         # includes tests
```

Lane evidence: report the suite counts from `npm test` (and `test:spawn` when
run), not just "green". Workflow: `../../../AGENTS.md` ("Subagent Lanes").
