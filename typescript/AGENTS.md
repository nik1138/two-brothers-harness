# AGENTS.md — `typescript/`

Guidance for coding agents working in the TypeScript reference. Project
overview and rules live in `../AGENTS.md`.

## What this is

A **zero-dependency** TypeScript reference implementation of the Two Brothers
protocol contract (`../PROTOCOL.md`). It documents the contract precisely; it
does **not** mirror the removed original prototype's module structure, and it
is not the implementation — `../packages/harness/` is.

## Layout

- `src/` — protocol reference modules
- `tests/` — in-process test runner (`run-all.ts`) plus `node --test` suites
- `tsconfig.json` — native type stripping (Node ≥ 22.6), no build step
- Inner guidance: `src/AGENTS.md` (module map + invariants),
  `tests/AGENTS.md` (suite registration + commands). Lane workflow:
  `../AGENTS.md` ("Subagent Lanes").

## Rules specific to this tree

1. **Zero dependencies.** No npm packages, no build step, no bundler. Node's
   native type stripping is the only toolchain. Do not add `package.json`
   dependencies. (The publishable TypeScript package lives in
   `../packages/harness/` — see `../docs/history/ts-rewrite-plan.md`; that
   tree has its own dependency rules. This reference stays zero-dependency.)
2. Run tests with `node tests/run-all.ts` (works in sandboxes);
   `node --test` (no path; run from `typescript/`) is the alternative where
   process spawning is allowed.
3. Protocol changes come from `../PROTOCOL.md` + `../shared/protocol.schema.json`
   and must be reflected here and in `../packages/harness/` together.
4. Context markers and rendered transcript strings are byte-stable contract
   strings shared with `../packages/harness/` — keep them identical.