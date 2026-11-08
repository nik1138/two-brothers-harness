# AGENTS.md — `packages/harness/src/`

Local map for the package sources. Project rules live in
`../../../AGENTS.md`; package-wide rules and commands in `../AGENTS.md`.

## What lives here

- `index.ts` — public API re-exports; a new public symbol is added here.
- `protocol.ts`, `payloads.ts`, `context.ts`, `session.ts` — envelope
  contract, tolerant parse → strict zod validation → sanitize, shared
  context, session JSONL (`seq`).
- `harness.ts` — cooperation state machine, prompt assembly, tool loop,
  payload repair, skills/steering wiring.
- `provider.ts` — OpenAI/Anthropic/Gemini adapters, retry/error registry,
  token/cache usage; `compaction.ts` — context compaction.
- `server.ts`, `runtime.ts`, `runevents.ts`, `metadata.ts` — plain
  `node:http` + SSE, worker-pool runs, approvals, event sidecars.
- `cli.ts`, `clihelp.ts`, `clilayout.ts`, `clistyle.ts`, `output.ts`,
  `completions.ts`, `doctor.ts` — CLI surface.
- Tool-facing modules: `workspace*.ts`, `shell.ts`, `mcp.ts`, `plugins.ts`,
  `skills.ts`, `commands.ts`, `toolschema.ts`, `permissions.ts`.
- `tui/` — the full-screen TUI modules.
- `config.ts`, `presets.ts`, `settings_store.ts`, `secretbox.ts` — settings,
  presets, encrypted secrets; `prompts.ts` loads `../shared/prompts.json`.

## Boundaries

- Product code lives here; tests mirror it in `../tests/`, package E2E in
  `../e2e/`, browser E2E in `../../../e2e/`, web sources in `../../../web/`.
- `../../../typescript/` is the zero-dependency protocol reference — do not
  modify it from a package lane.
- `../web/` and `../dist/` are generated; never edit or commit them.

## Invariants and hazards

- A protocol change starts at root `PROTOCOL.md` +
  `../../../shared/protocol.schema.json`, then lands here **and** in
  `../../../typescript/` with tests.
- Keep transcript markers byte-stable (`[[TASK]]`/`[[/TASK]]`,
  `[[REPAIR_REQUEST]]`, `[[OPERATOR STEER]]`, compaction summary markers).
  Prompt sections are code-only; both `prompts.json` copies stay identical.
- Validation is tolerant at the boundary: `parseModelOutput` → strict check →
  `sanitizePayload`; never throw on model output. Session `seq` stays dense;
  resume never re-appends. Permissions fail closed.
- Runtime dependencies are curated and exact-pinned (`zod`,
  `@earendil-works/pi-mcp`). A new runtime import needs a ledger entry in
  `docs/history/ts-rewrite-plan.md` and an owner decision.
- Sources import with `.ts` extensions; `tsc` rewrites them in `dist/`.

## Commands

```powershell
cd packages/harness
npm run typecheck
npm test
node src/cli.ts run "Plan a migration" --provider mock   # dev via type stripping
npm run build
node dist/selftest.js
```

A behavior change here also runs the hermetic CLI E2E: `node e2e/cli.ts`
(see `../e2e/AGENTS.md`). Lane workflow: `../../../AGENTS.md`.
