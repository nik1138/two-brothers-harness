# E2E (`packages/harness/e2e/`)

The live suites run the harness against a **live OpenAI-compatible endpoint**
(LM Studio) with the small local models `spark-x2.6-4b@q4_k_m` (senior) and
`lfm3-1.7b` (junior); they are the only non-hermetic test surface in the
package. The server-status suites (`e2e/server-status.ts`) and the
prompt-audit suite (`e2e/server-prompt-audit.ts`) are fully hermetic — mock
providers, in-process servers, temp dirs — and run even when no endpoint is
reachable. Everything under `tests/` stays offline; nothing here runs in
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
