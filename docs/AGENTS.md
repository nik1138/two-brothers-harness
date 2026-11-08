# AGENTS.md — `docs/`

Local map for the documentation set. Root rules: `../AGENTS.md`; the index is
`README.md` here.

## What lives here

- One flat set of topic files: `quickstart.md`, `cli-reference.md`,
  `testing.md`, `plugins.md`, `release.md`, `backlog.md`,
  `design-review.md`, `troubleshooting.md`, `keyboard.md`, `attribution.md`.
- `history/` — frozen records (`ts-rewrite-plan.md`, `cli-audit.md`,
  `web-ui-audit.md`, `handoff.md`); content is not rewritten.

## Boundaries

- All documentation is English. Add a new topic as a flat `docs/<topic>.md`
  and link it from `README.md`; do not create nested topic folders beyond the
  frozen `history/`.
- `docs/history/` is a record of past states, not current instructions; do not
  "fix" it to match today's code.
- Do not document a flag, env var, command, or endpoint the code does not have.

## Invariants and hazards

- `docs/cli-reference.md` is guarded by `packages/harness/tests/clidocs.test.ts`:
  the environment table and flag tables must match
  `packages/harness/src/clihelp.ts`. A new flag/env var lands in code and docs
  together.
- Keep links relative and valid; `README.md` is the index.
- Release/publish instructions in `release.md` are owner-run; a lane never
  publishes.

## Commands

```powershell
cd packages/harness
node --test tests/clidocs.test.ts    # docs ↔ CLI drift guard
npm test                             # full package suite
```

Workflow: `../AGENTS.md` ("Subagent Lanes").
