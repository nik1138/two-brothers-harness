# E2E (`packages/harness/e2e/`)

The live suites run the harness against a **live OpenAI-compatible endpoint**
(LM Studio) with the small local models `spark-x2.6-4b@q4_k_m` (senior) and
`lfm3-1.7b` (junior); they are the only non-hermetic test surface in the
package. The server-status suites (`e2e/server-status.ts`), the prompt-audit
suite (`e2e/server-prompt-audit.ts`) and the real-socket fault-injection runner
(`e2e/faults.ts`) are fully hermetic — mock/scripted providers, in-process
servers on ephemeral loopback ports, temp dirs — and run even when no endpoint
is reachable. Everything under `tests/` stays offline; nothing here runs in
`npm test`.

## Prerequisites

- **LM Studio serving** both models on an OpenAI-compatible endpoint
  (the default probe list includes `http://localhost:1234/v1` and
  `http://127.0.0.1:1234/v1`, plus the original dev machine's LAN address;
  point the suite at your own endpoint with `TWO_BROTHERS_E2E_BASE_URL`).
- **Node ≥ 22.6** (sources run via native type stripping).
- `npm run build` first for the `test:e2e:dist` variant.

## Running

```powershell
cd packages/harness
npm run test:e2e        # in-process, imports src/
npm run test:e2e:dist   # same suites against the built dist/ artifact
node e2e/server-status.ts   # hermetic status-contract suites only (no endpoint)
node e2e/server-prompt-audit.ts   # hermetic prompt_audit SSE suite only
node e2e/faults.ts   # hermetic real-socket retry/timeout/overflow faults (no endpoint)
```

Expected duration: roughly 6–10 minutes for the in-process suites, plus
~6–15 minutes for the server suites, depending on the machine (small models
at ~30–90 s per call; two full cooperation cycles, a work-mode run with tool
calls and approvals, a work-mode run for the status contract, two resume
cycles, and three HTTP server runs). The
hermetic status suites add well under a second.

## What it proves

| Suite | Asserts |
|---|---|
| `connection` | `GET /v1/models` answers within short timeouts and serves both models. |
| `consult` | Real consult cycle: exactly `message → consult → proposal → review → decision`; every envelope passes `validateMessage`; every payload passes strict zod `parsePayload` **except** model-invented wrong-type scalars (e.g. `decision` delivered as an object — the sanitize contract, inherited from the original prototype, fills missing keys but deliberately does not coerce those; they are recorded as quirks); decision non-empty; ≥ 4 model calls in the usage snapshot; `[[TASK]]`/`[[/TASK]]` markers in the rendered transcript; every raw model reply survives `parseModelOutput` + `sanitizePayload`. |
| `work` | Work mode with a temp workspace and a `CallbackBroker(() => "approve")`: exactly `message → delegation → deliverable → review → decision`; ≥ 1 approval reached the broker; `calc.js` exists with the requested function + comment and is verified on disk; deliverable carries ≥ 1 `tool:` artifact; review carries ≥ 1 `verify:` point. |
| `resume` | Two tasks on one session file with `restoreContext` (the `--resume` flow): seq stays dense `1..N`, no duplicates. |
| `connection-server` | The TS server (plain `node:http`) starts in-process on an ephemeral port backed by the live providers; `/api/sessions`, `/api/settings`, `/api/fs/browse` all answer. Inherits the global LM Studio probe for its SKIP gate. |
| `server-consult` | One real run over HTTP: `POST /api/runs` (202) → envelope kinds asserted over the SSE stream (`id:` frames strictly increasing), `run_end` completed with a non-empty decision and ≥ 4 model calls, `?after=` reconnect honored, and the session JSONL on disk validated (`validateMessage` + strict zod + dense seq). |
| `server-work-approvals` | Temp workspace registered via `POST /api/workspaces`, work-mode run; every `approval_requested` SSE event is answered through `POST /api/runs/{id}/approvals/{approval_id}` mid-stream and the matching `approval_resolved` arrives; `calc.js` verified on disk; session JSONL validated. |
| `server-status-waiting` | **Hermetic** (mock providers). A work-mode run parks: `approval_requested` then exactly one `run_status: waiting`; the record and pending-approvals endpoint agree (`waiting`); answering emits `approval_resolved` (allow) before `run_status: running`; the run completes (`queued → running → waiting → running`). A second run is stopped while parked: the wait resolves as deny/cancelled, statuses end `queued → running → waiting`, `run_end` is `cancelled`, and no phantom `running`/`run_error` appears. |
| `server-mode-contract` | **Hermetic.** Explicit `mode` round-trips through `POST /api/runs`, `GET /api/runs?session=`, and `GET /api/runs/{id}` (immediate and terminal); an omitted mode records the resolved config default; a later run adopting the same session keeps its own mode while the earlier record keeps its original; a reload of the list and both ids still carries each mode; an invalid mode is still a 400. |
| `server-error-restart` | **Hermetic.** A scripted provider failure emits `run_error` + failed `run_end` over SSE and the record + runtime sidecar carry the message; a second server instance over the same sessions dir (simulated backend restart, empty in-memory map) serves `GET /api/runs/{id}` rebuilt from the sidecar: `failed`, the exact original error, empty `task`/`mode`, same session/usage/timestamps; unknown ids still 404. |
| `server-prompt-audit` | **Hermetic** (`e2e/server-prompt-audit.ts`). A work-mode run with a scripted tool call streams one `prompt_audit` frame per provider call (count equals `run_end.usage.model_calls`, order `senior/delegation → junior/deliverable ×2 → senior/verify → senior/review → senior/decision`); each frame carries the `PromptAuditEntry` fields and nothing else (no prompt bodies); the audit precedes its call's tool round (`prompt_audit → tool_started → approval_requested/resolved → tool_completed → next prompt_audit → deliverable`) and verify/review/decision audits stay pinned to their envelopes; frames persist in the runtime sidecar, replay over `?after=N`, and never enter the protocol session file. |
| `server-status-waiting-live`, `server-mode-contract-live`, `server-error-restart-live` | The same three contracts against the real endpoint (work-mode park/allow/stop with real approvals; explicit/default/adopted modes; a real provider 4xx for an unserved model must survive the restart). Skipped when no endpoint is reachable. |

The four hermetic suites use mock providers, an in-process server on an
ephemeral port, and temp sessions/workspace dirs under the system temp
(cleaned up). They write an SSE event dump (`server-status-*-events-<ts>.json`,
`server-mode-contract-*-records-<ts>.json`,
`server-error-restart-*-events-<ts>.json`,
`server-prompt-audit-events-<ts>.json`) under `e2e/runs/`.

All server suites write their sessions directory (including the runtime
events sidecar) plus a captured SSE event dump (`server-*-events-<ts>.json`)
under `e2e/runs/`. Every raw model reply the server run made is recorded
through the same wrapper as the in-process suites, so the parsing-robustness
assertions cover the HTTP path too.

Iteration aid: `TWO_BROTHERS_E2E_ONLY=<substr>` runs only suites whose name
contains the substring (e.g. `server`).

## Hermetic CLI E2E (`e2e/cli.ts`)

`node e2e/cli.ts` (npm script `test:e2e:cli`) is a fully offline, scripted
end-to-end suite that drives the **CLI as a subprocess** — `node src/cli.ts`
by default, `node dist/cli.js` with `test:e2e:cli:dist` (`--dist` or
`TWO_BROTHERS_E2E_CLI_DIST=1`). Every scenario uses `--provider mock`, temp
sessions dirs under the system temp (cleaned up afterwards), and the
checked-in MCP demo fixture — no model endpoint, no network. Exit 0 = all
scenarios passed, 1 = at least one failed (PASS/FAIL lines per scenario, same
report idiom as above).

| Scenario | Asserts |
|---|---|
| `consult` | Exit 0; rendered kind sequence is exactly `message → consult → proposal → review → decision`; usage footer (`tokens: …`) present. |
| `work` | `--mode work`, exit 0; `message → delegation → deliverable → review → decision`. |
| `session+resume` | `--session-file` run → JSONL seq dense `1..5`; `--resume` follow-up → dense `1..10`, no duplicates; `sessions` lists the file with the derived title (first user message). |
| `mcp` | `--mcp-config tests/fixtures/mcp-config.stdio.json`, exit 0, MCP client loads (no `[warn] MCP:`); the mock run is unaffected. |
| `serve` | `serve` spawned on a free port with a temp sessions dir: `GET /api/sessions` → 200 list; `GET /` serves `web/dist/index.html` when the web app is built (404 + note otherwise); clean SIGTERM shutdown. |

Evidence per run: session JSONL files, `raw-replies-<ts>.json` (every model
reply exactly as it came off the wire), and `report-<ts>.json` (models,
envelope kinds, usage, approval count, durations, per-suite PASS/FAIL/SKIP,
observed model-output quirks) — all under `e2e/runs/` (gitignored).

## Real-socket fault injection (`e2e/faults.ts`)

`node e2e/faults.ts` (npm script `test:e2e:faults`) is a fully offline,
deterministic runner that starts a scripted `node:http` server on a loopback
ephemeral port and drives the package's **real** retry/timeout/overflow
machinery over real TCP (`fetch`/undici) — no fetch stubs, no external
network, temp dirs only. It fills the "no real-network fault injection" gap
without giving up hermeticity; the in-process registry/logic coverage stays in
`tests/`.

| Scenario | Asserts |
|---|---|
| `429-retry-after` | `429` + `Retry-After: 1` then success: exactly 2 attempts, and the header replaces the fixed backoff (the documented 1 s wait is recorded through the provider's `sleeper` seam); one recorded model call. |
| `5xx-transient` | `500`, `503` then success: exactly 3 attempts; waits equal the documented exponential backoff; one recorded model call. |
| `timeout-retry` | The first attempt hangs past a 400 ms per-attempt timeout and the retry succeeds: the documented `[warn] provider attempt timed out …` line, the same request re-sent, one recorded model call. |
| `overflow-surface` | A `413` context-overflow body raises `ProviderContextOverflowError` after ONE attempt even with 6 retries configured: no wait, classification `context-overflow`, no recorded usage. |
| `overflow-recovery` | A real seeded ~92 KB session: the first senior call overflows, the harness compacts once through the same socket-backed provider and retries the node once; the cycle completes (`consult → proposal → review → decision`), the session JSONL keeps exactly one summary and still restores/appends with dense `seq`. |
| `overflow-bounded` | The same seeded session against an always-overflow server: exactly 3 requests (overflow → one compaction → retried overflow) and then the documented error; never an infinite retry. |
| `quota-fatal` | `429 insufficient_quota` is fatal (`reason provider-limit`): one attempt, zero waits, no retry budget burned, the provider message preserved. |

Bounded and deterministic: each scenario has a 10 s watchdog and the whole run
must stay under 30 s (typically ~0.3 s — the documented backoff waits are
compressed through the provider's injectable `sleeper` seam; only the timeout
scenario uses real wall time). Every scenario owns its server and closes it in
`finally`; the exit code is 0 only when all scenarios pass, with one PASS/FAIL
line per scenario. Evidence (scenario results, durations, request counts) is
written to `e2e/runs/faults-report-<ts>.json` (gitignored). It is not part of
`npm test`; the offline smoke gate runs it as a package-gate step, and you can
also run it directly or via `npm run test:e2e:faults`.

## Real-network load run (opt-in/manual)

`node e2e/load.ts` (npm script `test:e2e:load`) is an **opt-in, manual**
real-network load runner: it spawns bounded-concurrency real CLI runs against
an operator-provided OpenAI-compatible endpoint and reports honest per-run
latency/outcome plus a summary. It fills the "real external-network load" gap
next to the hermetic real-socket fault layer (`e2e/faults.ts`); the in-process
registry coverage stays in `tests/`.

> **Warning:** it needs a **reachable endpoint** and sends **real model calls**
> (local or paid, depending on the endpoint). It is **never** run by
> `npm test`, the offline smoke gate or CI — there is no endpoint there. Run it
> manually / for release observation only.

It drives the published artifact: each run is
`node dist/cli.js run "<task>" --base-url … --senior-model <id> --junior-model <id>
--mode consult|work --timeout … --retries … --no-live`, so it exercises the same
provider path an operator would. **Run `npm run build` first**; when `dist/` is
missing the runner warns and falls back to `src/cli.ts` through Node native type
stripping. No new dependencies; nothing is built here.

```powershell
cd packages/harness
npm run build   # the runner prefers dist/cli.js
node e2e/load.ts --base-url http://localhost:1234/v1 --model lfm3-1.7b
node e2e/load.ts --base-url http://192.168.31.123:1234/v1 --model lfm3-1.7b `
  --concurrency 2 --runs 3 --timeout 900 --retries 1
npm run test:e2e:load -- --base-url http://localhost:1234/v1 --model lfm3-1.7b
```

| Flag | Default | Meaning |
|---|---|---|
| `--base-url <url>` | `TWO_BROTHERS_E2E_BASE_URL` (required) | OpenAI-compatible base URL; `http(s)` only. |
| `--model <id>` | `TWO_BROTHERS_E2E_MODEL` (required) | Model id used for **both** roles. |
| (endpoint auth) | `TWO_BROTHERS_API_KEY` | Read from the environment when the endpoint needs a key; this runner never passes keys in argv and never prints them. |
| `--concurrency <n>` | `3` (max 16) | Parallel CLI runs; the pool never exceeds it. |
| `--runs <n>` | = concurrency (max 100) | Total runs to execute. |
| `--mode <consult\|work>` | `consult` | Cooperation mode for each run. |
| `--timeout <s>` | `120` (max 3600) | Per-attempt provider timeout passed to the CLI. |
| `--retries <n>` | `1` (max 10) | Retries after a failed model call. |
| `--task <text>` | Redis→Valkey planning prompt | Task text for every run. |
| `-h`, `--help` | — | Usage, exit 0. |

Semantics: a run **succeeds** when its CLI child exits 0 (the CLI's own
definition: one completed cooperation cycle; a model produced decision is not
otherwise parsed here — use `--json` by hand if you need the protocol object).
The runner prints one `run <n>: PASS|FAIL in <s>s (exit …)` line per run (plus
a bounded stdout/stderr tail on failures) and a final `=== Real-network load
summary ===` block: planned runs, configured concurrency, **observed max
concurrency**, successes/failures with exit codes, latency `min/median/max`, and
total wall time. It deliberately prints **no invented throughput numbers** —
only measured values. Exit codes: `0` all runs succeeded, `1` at least one
failed, `2` invalid usage (with the reason and usage text on stderr). A soft
`GET <base-url>/models` probe runs first and reports reachability/model presence
without failing the run (some endpoints do not expose `/models`).

SIGINT/SIGTERM terminate every child run (`SIGTERM`, then `SIGKILL` after a
2 s grace) and exit 130/143; a normal exit sweeps any straggler child too, so a
cancelled load never leaves orphan CLI runs behind.

## serve-level load/soak (opt-in/manual)

`node e2e/serve-load.ts` (npm script `test:e2e:serve-load`) is the **serve-level**
counterpart of the CLI load runner: it starts the real `serve` backend, registers
a temp workspace and one session per run over HTTP, submits a bounded-concurrency
batch of `POST /api/runs`, polls `GET /api/runs` until every run is terminal, and
reports honest per-run `queued -> running -> completed` timings plus a summary.
It exercises the actual **RunManager / worker-pool / queue** path, which the
CLI-level runner cannot see.

> **Warning:** it starts a local server and, in real mode, needs a **reachable
> endpoint** and sends **real model calls**. It is **never** run by `npm test`,
> the offline smoke gate or CI — manual / release observation only.

**Run `npm run build` first** (it spawns `dist/cli.js serve`; when `dist/` is
missing it warns and falls back to `src/cli.ts` through Node native type
stripping). No new dependencies; nothing is built here. The `--mock` mode is a
hermetic self-test: the mock provider needs no endpoint at all.

```powershell
cd packages/harness
npm run build
# hermetic self-test: real serve + RunManager/queue, no endpoint needed
node e2e/serve-load.ts --mock --runs 3 --workers 1
# real endpoint (owner LM Studio example); keep the batch small — the model is slow
node e2e/serve-load.ts --base-url http://192.168.31.123:1234/v1 --model lfm3-1.7b `
  --runs 2 --workers 1 --timeout 900 --retries 1
npm run test:e2e:serve-load -- --mock --runs 3
```

| Flag | Default | Meaning |
|---|---|---|
| `--mock` | off | start `serve --provider mock` (hermetic self-test; no endpoint; a supplied `--base-url`/`--model` is ignored with a warning). |
| `--base-url <url>` | `TWO_BROTHERS_E2E_BASE_URL` (required in real mode) | OpenAI-compatible base URL; `http(s)` only. |
| `--model <id>` | `TWO_BROTHERS_E2E_MODEL` (required in real mode) | Model id used for **both** roles. |
| (endpoint auth) | `TWO_BROTHERS_E2E_API_KEY` | Forwarded to the serve child as `TWO_BROTHERS_API_KEY` when set; ambient provider switches are scrubbed and the runner never prints keys. |
| `--runs <n>` | `3` (max 50) | Total runs submitted. |
| `--workers <n>` | `1` (max 32) | Passed as `serve --workers`; 1 keeps queueing visible. |
| `--concurrency <n>` | = runs (max 50) | Max in-flight `POST /api/runs` submissions. |
| `--port <n>` | `8631` | serve port; fails clearly when busy. |
| `--timeout <s>` | `120` (max 3600) | Per-attempt provider timeout (serve `--timeout`). |
| `--retries <n>` | `1` (max 10) | Retries after a failed model call (serve env). |
| `--task <text>` | Redis→Valkey planning prompt | Task text for every run. |
| `--keep` | off | Keep the temp sessions dir + workspace for inspection. |
| `-h`, `--help` | — | Usage, exit 0. |

Design notes: every run gets its **own session** (`POST /api/sessions`,
workspace-linked) because RunManager strictly serializes runs that share a
session (context `seq` invariant) — per-run sessions are what let `--workers > 1`
actually run concurrently; with the default `--workers 1` the queue is what you
measure. State sequences are taken from the authoritative per-session runtime
sidecars (`<sessions>/runtime/<session>.events.jsonl`): HTTP polling alone can
miss transitions (a mock run can block the server's event loop), so the runner
merges the persisted `run_status`/`run_end` sequence with what it polled. Per-run
timings are **client-observed** (one `GET /api/runs` snapshot per poll interval;
whole-second server records are used only when a transition was missed), and the
`submit` latency on each line reports client-observed POST latency: under load
later submissions can lag behind the first run, but submit latency alone is not
the queueing proof — the persisted sidecar `queued -> running -> terminal`
sequence (counted in the summary) is the authoritative evidence. On a quiet
machine the mock self-test can complete in a few hundred milliseconds per run.

The runner prints one `run <n>: PASS|FAIL <state> (total/queued/ran/submit,
model calls, queued -> running -> completed [session])` line per run, then a
final `=== serve-level load summary ===` block: mode, serve settings, runs,
configured vs **observed max in-flight POSTs**, **observed peak queued/running**,
the count of runs whose server-side `queued -> running -> terminal` sequence was
persisted, successes (`completed`) / failures, terminal-state counts, queue-wait
and execution `min/median/max`, submit latency `min/median/max`, total wall time. Exit codes: `0` every run reached `completed`,
`1` at least one run failed/cancelled/missed the batch deadline or the server
could not start, `2` invalid usage. The batch deadline is derived from
`--timeout` and `runs/workers`; stragglers are cooperatively stopped
(`POST /api/runs/{id}/stop`) and reported as failures. SIGINT/SIGTERM stop the
serve child and exit 130/143; a normal exit stops it too (SIGTERM, SIGKILL after
a 5 s grace), and the temp dirs are removed unless `--keep` — no orphan server.

## Automation mode (`--mode print|json`)

For CI and other non-interactive callers, `run` accepts pi-style output modes
(verified offline by `tests/printmode.test.ts`, part of `npm test`):

- `--mode print` — stdout carries only the final decision text (one line).
  With `--json`, stdout carries the decision object as JSON instead. The
  usage footer and all warnings go to stderr, so stdout stays pipe-clean.
- `--mode json` — stdout is exactly one JSON object:
  `{task, events, decision, usage, cost, rounds, errors}` (`events` is the raw
  envelope list, `usage` the merged token totals, `cost` the estimated USD
  cost or `null` for unknown models). Nothing else is printed
  to stdout; diagnostics stay on stderr. A bare `--json` with no explicit
  `--mode` selects this mode (it only narrows `--mode print`).
- `--json-events` — alias for `--mode json`, so it composes with a
  cooperation mode: `--mode work --json-events`.

Exit codes: `0` success, `1` run errors (e.g. session-file conflict,
errors recorded during the run), `2` usage errors (missing task, unknown
command). Example:

```powershell
node dist/cli.js run "x" --provider mock --mode json | ConvertFrom-Json
```

Note: `--mode` remains the cooperation-mode flag (`consult|work|auto`);
`print`/`json` are intercepted by the CLI as output modes, leaving the
cooperation mode at its default (or `TWO_BROTHERS_MODE`).

## SKIP semantics

E2E is opt-out friendly for machines without LM Studio:

- **Endpoint unreachable** (all candidate URLs fail the 5 s connect / 10 s
  total probe) or **required models not served** → the runner prints
  `E2E SKIP: <reason>`, records a `connection` SKIP, and does not run the
  live suites. The **hermetic `server-status-*` suites still run**, so the
  status contract is verified offline; exit 0 when they pass.
- Individual suites can also end `SKIP` (e.g. a live status suite when the
  model never parks on an approval): informational only, still exit 0. The live status suites SKIP if the model
  never parks on an approval (model behavior, not a contract break).
- Any real assertion failure exits 1 (`E2E: FAIL`). Model quirks the
  tolerant pipeline is designed to absorb (unstructured replies, dropped
  unknown keys, wrong-type scalars such as an object `decision`) are
  recorded in the report's `quirks` list instead of failing the suite —
  the strict-pipeline semantics are never weakened. Structural zod issues
  (bad enum, missing required key, wrong shape) always fail.
