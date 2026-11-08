# AGENTS.md — `typescript/tests/`

Local map for the reference test suite. Parent rules: `../AGENTS.md`; root
rules: `../../AGENTS.md`.

## What lives here

- `*.test.ts` — `node:test` suites for `../src/` (protocol, harness, session).
- `run-all.ts` — in-process entry that imports every suite
  (`node tests/run-all.ts`).

## Boundaries

- Zero dependencies, no build, no network. This suite documents the protocol
  contract alongside the reference sources.
- Do not add package-only features here; mirror contract changes with
  `packages/harness/tests/` in the same change.

## Invariants and hazards

- **Register every new suite in `run-all.ts`.** `node tests/run-all.ts` only
  runs what it imports; `node --test` (no path, from `typescript/`) discovers
  the suites by itself.
- Keep assertions contract-level (envelope shape, markers, seq, parsing), not
  implementation details of the reference.

## Commands

```powershell
cd typescript
node tests/run-all.ts
node --test
```

Workflow: `../../AGENTS.md` ("Subagent Lanes").
