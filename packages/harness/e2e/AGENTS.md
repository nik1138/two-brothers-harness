# AGENTS.md — `packages/harness/e2e/`

Local map for package-level end-to-end suites. Parent rules: `../AGENTS.md`;
root project rules: `../../../AGENTS.md`; the detailed suite matrix is in
`README.md` here.

## What lives here

- Hermetic, offline suites: `cli.ts` (CLI subprocess, mock provider),
  `faults.ts` (real-socket retry/timeout/overflow), `server-status.ts` and
  `server-prompt-audit.ts` (in-process server contracts).
- Live suites: `run.ts` / `run-dist.mjs` against LM Studio
  (`spark-x2.6-4b@q4_k_m` senior, `lfm3-1.7b` junior).
- Opt-in manual load runners: `load.ts` (CLI-level) and `serve-load.ts`
  (RunManager/queue-level). Both can send real model calls.
- `runs/` — gitignored evidence (JSONL sessions, SSE dumps, reports).

## Boundaries

- Never move hermetic suites under `../tests/` or into `npm test`; keep the
  offline/live split. The smoke gate runs `cli.ts` and `faults.ts`; CI runs
  `run.ts` with a closed endpoint so live suites SKIP and hermetic ones run.
- Live/manual runners are never part of offline gates or CI. They need a
  reachable endpoint and may cost money; run them only when the brief says so.
- Do not commit `runs/` evidence, keys, or generated session dirs.

## Invariants and hazards

- Exit 0 only when every executed scenario passed (SKIPs are informational and
  still exit 0 when hermetic suites pass); exit 1 on any assertion failure.
- `run-dist.mjs` and `cli.ts --dist` need `npm run build` first.
- Keep each scenario's temp dirs, server, and child processes closed in
  `finally`; the fault runner is bounded (10 s per scenario, 30 s total).
- Manual runners print measured values only — never invented throughput.

## Commands

```powershell
cd packages/harness
node e2e/cli.ts                 # hermetic CLI E2E (sources)
node e2e/cli.ts --dist          # same against dist/ (build first)
node e2e/faults.ts              # hermetic real-socket faults
node e2e/server-status.ts       # hermetic server-status suites
node e2e/server-prompt-audit.ts # hermetic prompt-audit SSE suite
npm run test:e2e                # live LM Studio suites
npm run test:e2e:dist           # live against dist/
node e2e/load.ts --base-url <url> --model <id>   # opt-in, real network
node e2e/serve-load.ts --mock --runs 3           # serve self-test
```

Workflow and evidence rules: `../../../AGENTS.md` ("Subagent Lanes").
