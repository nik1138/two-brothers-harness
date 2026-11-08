# Design Review v0.1

An honest critique of the current version and what to improve.

> **Current framing (2026-11-04):** this is the v0.1 design review, written
> against the original Python/LangGraph prototype, and it is kept as a
> historical critique. The implementation is the TypeScript package
> (`packages/harness/`). The original prototype was removed from the
> repository on 2026-11-04 (git history keeps it). Features described here as
> done ship in the TypeScript package, together with later work — context
> compaction, MCP role scoping, plugins, the run-status contract
> (`run_status: waiting`), and the provider error-classification/retry
> registry. Mechanisms named below that belong to the removed prototype
> (LangGraph, `LangChainResponder`, its `two_brothers serve` command) are
> historical record, not runnable instructions.

## What is done well

- **One shared context** for both brothers — verified by a test
  (`shared context is identical for both roles`).
- **Explicit roles**: different system prompts, different models, senior as arbiter.
- **Structured protocol**: envelope + 7 kinds + JSON Schema; the TypeScript
  package (zod) and the zero-dependency TypeScript reference validate the same
  thing.
- **A real revise loop**: the senior can demand rework, not just "accept everything".
- **Zero-dependency TypeScript reference**: native type stripping, no npm
  packages. The removed prototype intentionally built on an external graph
  framework; the TypeScript package is the implementation.
- **Executable delegation (v0.3)**: with `--mcp-config`, the junior receives
  MCP tools in `work` mode and performs real work instead of only describing
  it.
- **Evidence**: a full cycle on a real `spark-x2.6` is captured in
  [`SPARK-TRANSCRIPT.md`](../SPARK-TRANSCRIPT.md) (the replay script lived
  in the removed prototype tree).
- **A local coding workspace (v1)**: the web backend gives the junior confined
  filesystem/shell tools rooted at an operator-registered directory; reads
  auto-allow, mutations and shell commands pause the run on an operator
  approval (fail closed — no broker means denial), and tool/diff/approval
  history persists in per-session runtime sidecars. The senior gets read-only
  workspace checks to ground its review in observed file state.
- **Async web runs**: background runs on a worker pool (default 2; same-session
  runs stay serialized) with typed SSE events, cooperative stop, reconnectable
  streams (`?after=N`), follow-up messages into the same session, and per-role
  Senior/Junior settings (API keys never leave the backend).

## Limitations

### 1. One process, two brothers

In v0.1 both brothers live in one process/session. Cross-language cooperation
(a Python brother ↔ TypeScript brother) requires a transport (socket/pipe/HTTP)
and separate processes. The protocol is ready for this, but the transport is
not implemented.

### 2. The senior does not "decide on its own"

The cycle always starts with `consult`/`delegation`. There is no branch where
"the senior decides without consulting". `auto` in v0.1 effectively = `consult`.

### 3. No real mode selection

`auto` does not choose between advice and delegation based on the task's
content — it deterministically reduces to `consult`.

### 4. One junior round by default

`--max-rounds` limits revise rounds, but the senior cannot ask several
questions in a row or clarify details without a new revise cycle.

### 5. Request/response provider only

No streaming, no retry/backoff, no fallback to another model on 429/5xx.
No token or cost accounting.

**Addressed later:** bounded retries with exponential backoff owned by
`LangChainResponder` (see "Run failures" below) and per-run token usage on
`run_end` events / run records (`usage`: `model_calls`, `input_tokens`,
`output_tokens`, `cached_tokens`). Still missing: streaming and model
fallback.

**TS-first now:** in the TypeScript package the retry loop is driven by an
ordered `PROVIDER_ERROR_REGISTRY` (retryable 408/409/429/5xx and transport
errors; `Retry-After` honored; other 4xx, quota/billing and context-overflow
fail fast, with overflow triggering compact-and-retry). Streaming and
accounting have since shipped too: `run --stream` / `--stream-tokens` emit
bounded NDJSON run events and per-text-delta `token` records (the TUI
renders deltas in place), and a hand-maintained price table drives a `cost:`
line plus a `cost` field in `--mode json`. Model fallback on 429/5xx is
still the open gap. The `LangChainResponder` behavior described below
belongs to the removed prototype and is kept for the record.

### 6. In-memory context only

No persistence: the session is lost on exit. `chat` does not keep history
between runs.

**Addressed in v0.2:** JSONL session persistence + resume — `--session-file`
appends every protocol envelope to the file (flushed immediately), `--resume`
rebuilds the shared context with dense `seq` numbering, and `chat` keeps one
persisted context across all REPL tasks.

**v0.3 note (historical):** the original prototype's cooperation loop became a
LangGraph state machine with internal `MemorySaver` checkpointing (that tree
was removed on 2026-11-04). That checkpointing was runtime state
only; JSONL sessions remain the persistence format and the web viewer reads
those JSONL files. The zero-dependency constraint applies to the
TypeScript reference implementation.

### 7. Strict schema vs real models

Real models add extra fields (`note` in spark-x2.6) or wrap JSON in text. The
harness tolerates this (`sanitize_payload`, `parse_model_output`), but the
"lenient" behavior is not documented in the schema as allowed.

### 8. Security

`--api-key` is passed as a CLI flag (it lands in the process history). For
production — env vars / a secret store only.

### 9. Tests

No automated integration tests against a real external network; no
wall-clock/throughput load tests in the gates (the hermetic scale suite covers
large sessions and transcripts, 200-session listings, concurrent runs and
repeated compaction). Timeout, retry/backoff, context-overflow recovery and
quota classification ARE driven over real loopback TCP by the fault-injection
runner (`packages/harness/e2e/faults.ts`, part of the offline smoke gate and
CI) — it is hermetic and fast, but deliberately not a WAN or load test.
Real-network load is available as an opt-in manual runner
(`packages/harness/e2e/load.ts`, `npm run test:e2e:load`) with recorded
LM Studio evidence (concurrency 2 / runs 3: 3/3 PASS, 78.7–93.7 s per run);
WAN fault injection, a `serve` RunManager/worker-pool load and long soaks
remain deliberately manual/out of the offline gates.

### 10. The web workspace is single-user, single-process

Run records and pending approvals live in the backend process's memory, but
persistence is finer-grained than "restart loses everything": role settings
and presets survive in `sessions/settings.json` (API keys sealed at rest),
session JSONL and runtime sidecars are durable, and a terminal run record is
rebuilt after a restart — `GET /api/runs/{id}` falls back to the per-session
runtime sidecar and reconstructs a failed/cancelled record (with a
`rebuilt: true` marker; `task` and `mode` are not event fields and come back
empty). Only *pending* approvals and live run state are truly lost on
restart. Runs execute on a **worker pool** (default 2 workers,
`TWO_BROTHERS_WORKERS` / `Config.workers`): runs for different sessions run
concurrently, while runs for the *same* session stay strictly serialized —
the session file is a shared context and overlapping runs would corrupt
envelope `seq` continuity. A run submitted while all workers are busy stays
`queued` (backpressure, no rejection); there is no auth and no remote access
by design. Approval requests reach the operator over the SSE stream
(`approval_requested`) and are answered with `POST
/api/runs/{id}/approvals/{approval_id}` — no polling.

## Run failures (2026-10-31 incident hardening)

Real-use incident: with no settings saved, a web run silently used baked-in
defaults pointing at a local gateway (`127.0.0.1:8787`, `*-free` models) —
the first run burned ~9 minutes in 429 retry backoff before failing; the next
run hung entirely and Stop could not unwind it. Fixes now in place:

- **No baked-in endpoint.** `base_url`/`senior_model`/`junior_model` default
  to empty. When a run resolves to provider `openai` with an empty base URL
  or model for a needed role, it fails fast — before any network I/O — with a
  readable message ("no base_url configured for the senior role — set it in
  Settings, or pass --base-url / set TWO_BROTHERS_BASE_URL"). Mechanism:
  `config.openai_role_problem` / `validate_run_config`, enforced in
  `responders.build_responder` (covers every run path) and at the CLI run /
  REPL entry. On the web backend a background run still returns 202 but ends
  `failed` within seconds through the normal `run_error` path; the legacy
  synchronous `POST /api/run` answers 400 with the same message. `mock` runs
  are unaffected; env vars and CLI flags override as before.
- **Bounded calls.** `Config.timeout` (default 120 s) is wired into
  `ChatOpenAI` as its per-request HTTP timeout (`timeout=` is the pydantic
  alias of `request_timeout` in langchain-openai) — it bounds *every attempt*
  of the retry loop. Retries are owned by our code, not the SDK
  (`max_retries=0`): `LangChainResponder.invoke` makes at most `retries + 1`
  attempts (default 7; `Config.retries`, env `TWO_BROTHERS_RETRIES`, CLI
  `--retries`) with exponential backoff between attempts (base 2 s, factor 2,
  cap 30 s → waits 2, 4, 8, 16, 30, 30; pure `_backoff_delays()` + injectable
  sleeper, pinned in `tests/test_retry_usage.py`). The run's cancel event is
  checked before every attempt and wakes the backoff wait, so a stopped run
  aborts the loop immediately instead of sleeping through a 30 s backoff.
  A hung or slow endpoint therefore surfaces as a run error mentioning the
  timeout within seconds — `tests/test_responders.py` pins this against a
  socket that accepts and never responds.
- **Stop during an in-flight call.** Cancellation stays cooperative (it takes
  effect between responder calls), but a bounded call can no longer hang
  forever; when Stop lands mid-call and the call then errors out,
  `RunManager` records the run as `cancelled` (not `failed`) — see
  `tests/test_runtime.py::RunManagerTest::test_stop_during_inflight_call_ends_cancelled`
   and `tests/test_server.py::BackgroundRunsApiTest::test_stop_during_failing_call_ends_cancelled`.
  The approval broker's deny-on-stop behavior is unchanged.
- **Where run errors are visible.** A failed/cancelled run emits a typed
  `run_error` event followed by `run_end`; both are buffered in the run
  record for SSE and persisted by the backend to the per-session sidecar
  `sessions/runtime/<name>.events.jsonl`. The protocol session JSONL itself
  only ever contains envelopes — a run that fails at start-up writes nothing
  there (which is also why a failed run leaves no partial transcript).

## Priorities for the next version

1. **Transport** for cross-language cooperation (socket/HTTP).
2. **Persisted context** (JSONL/DB) + session resume — done in v0.2
   (`--session-file` / `--resume`).
3. **Fallback to another model** on 429/5xx (retry/backoff and per-run token
   usage accounting are done: `run_end` events and run records carry a
   `usage` object — `model_calls`, `input_tokens`, `output_tokens`,
   `cached_tokens` — captured from `AIMessage.usage_metadata` /
   `response_metadata.token_usage`).
4. **A "decide solo" branch** and a real `auto`.
5. **More roles** (a third brother/sister) without changing the protocol.
6. **GUI/API** on top of the harness — done in v1: the web workspace (Vue 3 +
   Vite frontend; TypeScript package backend via `node dist/cli.js serve`)
   with workspaces, async runs, operator approvals, and changed-file
   review.
