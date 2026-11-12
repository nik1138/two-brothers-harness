# AGENTS.md — `shared/`

Local map for the canonical shared contract files. Root rules:
`../AGENTS.md`.

## What lives here

- `prompts.json` — the canonical senior/junior system prompts.
- `protocol.schema.json` — the machine-readable envelope schema.

## Boundaries

- These files are part of the protocol contract. Do not change them as a
  drive-by cleanup or reformat them.
- `prompts.json` is copied to `packages/harness/shared/prompts.json` for the
  npm tarball; the copy must stay byte-identical.
- Schema changes follow the root hard rule: `PROTOCOL.md` → schema →
  `packages/harness/` + `typescript/` implementations and tests.

## Invariants and hazards

- Prompt sections (`## Available tools`, skills) are assembled in code; do not
  add them to `prompts.json`. The per-node payload example is not a prompt
  section at all: it rides on the request's transcript user turn
  (`withReplyFormat` in `packages/harness/src/harness.ts`).
- Do not put a literal fenced JSON block in `prompts.json`:
  `packages/harness/e2e/faults.ts` identifies the requested node from the
  structural `Requested payload: <kind>` marker in the request's user turns,
  with the legacy system-prompt fence/transcript only as fallbacks.
- Keep JSON key order and whitespace stable to avoid noisy diffs.
- Both implementations and both prompt copies are checked by their suites; a
  schema-only edit with no code/tests is incomplete.

## Commands

```powershell
# from the repo root
Get-FileHash shared/prompts.json, packages/harness/shared/prompts.json
cd packages/harness
npm test
cd ../../typescript
node tests/run-all.ts
```

Workflow: `../AGENTS.md` ("Subagent Lanes").
