# AGENTS.md — `typescript/src/`

Local map for the zero-dependency protocol reference. Parent rules:
`../AGENTS.md`; root rules: `../../AGENTS.md`.

## What lives here

- `protocol.ts`, `context.ts`, `harness.ts`, `provider.ts`, `session.ts`,
  `config.ts`, `prompts.ts` — the readable reference implementation of
  `../../PROTOCOL.md`.
- `cli.ts` — `run` / `chat` / `selftest` entry.
- `selftest.ts` — offline gate (`node src/selftest.ts`).

## Boundaries

- This tree **documents the contract**; product work lands in
  `../../packages/harness/`. Do not port features here.
- Zero dependencies, no build step, no bundler: native type stripping only.
- Keep behavior aligned with `packages/harness/` and the root schema; a
  deliberate divergence needs a protocol/docs decision, not a local edit.

## Invariants and hazards

- Protocol changes start at `../../PROTOCOL.md` +
  `../../shared/protocol.schema.json`, then land here **and** in
  `packages/harness/` with tests.
- Context markers and rendered transcript strings (`[[TASK]]`/`[[/TASK]]`,
  "Context events:") are byte-stable contract strings shared with the package.
- Tolerant parse → sanitize; dense session `seq`; resume never re-appends.
- Imports use `.ts` extensions.

## Commands

```powershell
cd typescript
node src/selftest.ts
node src/cli.ts run "Plan a migration" --provider mock
node tests/run-all.ts
node --test                    # no path; run from typescript/
```

Workflow: `../../AGENTS.md` ("Subagent Lanes").
