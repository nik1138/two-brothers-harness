# Testing

The **implementation is the TypeScript package** (`packages/harness/`,
`@two-brothers/harness`): its gates are what decide whether the product is
green, and new tests land there. The `typescript/` tree is the zero-dependency
protocol reference; its suite is kept as a contract check.

## Quick check

```powershell
cd two-brothers-harness
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
```

(`pwsh` is not installed on this machine; use Windows PowerShell as above.)
The script runs:

1. `packages/harness` `npm run typecheck`
2. `packages/harness` `npm run build`
3. `packages/harness` `npm test`
4. `node dist/selftest.js`
5. a demo run through the built CLI on `mock`
6. the hermetic CLI E2E (`node e2e/cli.ts`)
7. the `typescript/` reference selftest
8. the `web/` build

Expected final line: `SMOKE TEST: PASS`. It is an offline pre-flight, not the
whole product gate — run the package gates below for that.

## TypeScript package (primary)

```powershell
cd packages/harness
npm install
npm run typecheck
npm run build
npm run selftest        # node dist/selftest.js (after build)
npm test                # in-process node:test runner
npm run test:spawn      # node --test tests/ (child processes allowed)
```

Coverage: envelope and payload validation (zod), model output parsing,
`sanitize_payload`, the consult/work/revise state machine, byte-stable
transcript markers, session persistence (`--session-file` / `--resume`,
dense `seq`), context compaction, MCP loading and role scoping, the plugin
loader, the HTTP/SSE server and its run-status contract, the
provider error-classification registry, and the workspace tools
(confinement, approvals, diffs). Hermetic offline CLI E2E:
`npm run test:e2e:cli` (sources) / `npm run test:e2e:cli:dist` (built
`dist/cli.js`) drive the CLI as a subprocess against the mock provider.

## TypeScript reference (`typescript/`)

Zero-dependency; documents the `PROTOCOL.md` contract and is not modified by
feature work.

```powershell
cd typescript
node src/selftest.ts
node tests/run-all.ts
```

`node --test tests/` also works where spawning child processes is allowed
(in sandboxes it can fail with `EPERM` — use `run-all.ts` there).

Coverage: envelope and payload validation, model output parsing, `sanitize_payload`,
the consult/work/revise loop, configuration precedence, and session persistence
(`tests/session.test.ts` — JSONL round-trip, resume with dense seq numbering,
missing/corrupt files). The `selftest` also includes an offline persistence
round-trip.

## End-to-end (E2E)

Two automated E2E layers complement the unit suites. Both are hermetic:
temp dirs, free ports, mock/scripted providers only, child processes reaped
after every run.

**Browser E2E** — `e2e/` (own package; `playwright` is the only dependency).
It drives the installed Edge headless, so no browser download is needed:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
# or directly (repo root):
node e2e/run.mjs
```

Scenarios: group-chat run with the mock provider (distinct role bubbles, no
raw-protocol leakage), reload/resume, approval card → file on disk →
changed-file diff (allow and deny paths), and stop. Every scenario runs
against the TypeScript backend (`packages/harness/dist/cli.js serve`, built
from this checkout). Fixture-backed scenarios drive a scripted
OpenAI-compatible model server (`e2e/fixtures/scripted-server.mjs`) through the
real approval broker, and skip (never fail) when the built CLI is missing. The
suite's temp dirs live under `<repo>/.e2e-tmp/` (gitignored).

### Package real-model E2E (opt-in)

`packages/harness/e2e/` drives the TypeScript package against LM Studio
(`npm run test:e2e` on sources, `npm run test:e2e:dist` on the built
`dist/`). Same models and endpoint as below; reports land in
`packages/harness/e2e/runs/`. An unreachable endpoint prints `E2E SKIP:` and
exits 0, so the suite stays safe on a machine without LM Studio.

### Browser real-model E2E (opt-in)

The suite also has a `real` scenario that makes genuine model calls. It is
**off by default** — the normal suite stays fully offline:

```powershell
# Git Bash
TWO_BROTHERS_REAL_E2E=1 node e2e/run.mjs

# Windows PowerShell
$env:TWO_BROTHERS_REAL_E2E = '1'; node e2e/run.mjs
```

Requirements: LM Studio serving the OpenAI-compatible API on localhost,
e.g. `http://localhost:1234/v1` (point the suite at your endpoint with
`TWO_BROTHERS_LM_BASE`) with both models loaded — `spark-x2.6-4b@q4_k_m`
(senior) and `lfm3-1.7b` (junior).

What it proves, end to end through the real backend and the browser UI:

- per-role provider/model settings (`PUT /api/settings`) drive a run with no
  provider override ("from settings");
- the full consult cycle (senior consult → junior proposal → senior review →
  decision) renders as the same chat groups as the mock scenario;
- the run's SSE stream ends with `run_end status=completed`, and the run
  record carries a numeric `usage` object (`model_calls`, `input_tokens`,
  `output_tokens`, `cached_tokens`);
- total wall time stays under a 10-minute deadline.

Runtime: minutes, not seconds — two real models each answer several times,
so expect roughly 2–5 minutes for the scenario on this machine (the deadline
is 10 minutes). If LM Studio is unreachable or a model is missing, the
scenario reports `SKIP` (never `FAIL`), exactly like a missing fixture.
Without the flag it prints `SKIP real (set TWO_BROTHERS_REAL_E2E=1)`.

## Why spark-x2.6 is not in the CLI

`spark-x2.6` is only reachable through the DSH `xhtoken` provider; it has no
HTTP endpoint, and direct internet access from the sandbox is blocked. The full
cycle on it was run through a `subagent` and captured in
[`SPARK-TRANSCRIPT.md`](../SPARK-TRANSCRIPT.md).

## What is not covered by tests

- Real network errors / timeouts / 429s (only mock HTTP).
- Behavior with very long contexts.
- Concurrent sessions; the web workspace backend is single-user and runs
  cooperate on one FIFO worker (runs queue), so true parallelism is untested.
- Restart recovery: session JSONL, `*.meta.json`, and
  `sessions/runtime/*.events.jsonl` survive a backend restart, but in-memory
  run state (run records, pending approvals) does not.
