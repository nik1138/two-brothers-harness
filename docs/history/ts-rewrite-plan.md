# TypeScript rewrite plan (core + execution tier)

Status: active goal plan. Authoring date: 2026-11-01.

Status (2026-11-01): **goal complete.** All 7 stages done — core +
execution tier ported, 147 tests passing (+1 environmental skip: symlink
creation disallowed on this machine), CLI at parity (byte-identical mock
output vs Python incl. usage footer), packed-tarball install verified.
See [`handoff.md`](handoff.md) (TypeScript npm-package port section) for the verification
table. (Product-shell module 1 adds the settings + secret stores
(`settings_store.ts` + `secretbox.ts`, 17 more tests — no new runtime
dependencies). Product-shell module 2 adds the runtime manager + runtime
event store + approval broker (`runtime.ts` + extended `runevents.ts`,
32 more tests — no new runtime dependencies). Product-shell module 3 adds
the HTTP server + SSE (`server.ts` + `metadata.ts` + `workspace.ts`
registry + `cli.ts serve`, 30 more tests — no new runtime dependencies;
plain `node:http`, see the ledger). Status (2026-11-02): MCP with
role-scoping is also shipped (`src/mcp.ts` on `@earendil-works/pi-mcp`).
Status (2026-11-02, second note): per-role provider endpoints are shipped
(Stage 18 — `runtime.ts::resolveRoleEndpoints` + `HarnessOptions.endpoints`
+ `--senior-base-url/--senior-api-key/--junior-base-url/--junior-api-key`;
python `server.py::_resolve_role_endpoint` parity, per
`research/harnesses/provider-settings-design.md`; 17 more tests — no new
runtime dependencies). Status (2026-11-02, third note): the plugin system
is shipped (BACKLOG "Plugins port" — `src/plugins.ts`, the
`python/plugins.py` port: fail-soft `plugins/` loader, `PluginContext` with
confined workspace helpers, per-role assignment into the `toolScopes`
registry, real `GET /api/plugins`; 31 more tests — no new runtime
dependencies). Status (2026-11-02, fourth note): context compaction is
shipped (BACKLOG "Context compaction" — `src/compaction.ts`, pi-durable's
algorithm ported per `research/harnesses/pi-durable-mcp-chord.md`:
`selectCut` / `serializeConversation` / the pinned summarization prompts,
char-budget policy, harness trigger between nodes, `--compact` /
`--compact-threshold` CLI + `TWO_BROTHERS_COMPACT*` env; 14 more tests —
no new runtime dependencies; the summary rides as a marked `message`
envelope so the protocol contract and session JSONL shape are untouched;
documented TS-first divergence — the Python implementation has no
compaction). Status (2026-11-02, fifth note): MCP hardening is shipped
(`src/mcp.ts` per `research/pi-adoption.md` §MCP and pi's coding-agent MCP
adapter: `mcp__<server>__<tool>` namespacing with a 64-char cap and stable
sha256 collision suffix, `displayNames` for readable transcripts, the
20 KiB result cap with the shared truncation marker, per-call `timeoutMs`
default 60 s with a per-server config override, and `@earendil-works/pi-mcp`
pinned at the exact `1.5.0`; 6 more tests — no new runtime dependencies;
TS-first divergence: Python's `mcp.py` exposes raw names and has no cap or
timeout). Status (2026-11-02, sixth note): provider error classification,
`Retry-After` honoring and context-overflow detection are shipped
(`src/provider.ts`, ported from pi-ai's
`utils/{retry,provider-retry,overflow}.ts`: the ordered
`PROVIDER_ERROR_REGISTRY`, `Retry-After` capped at 120 s,
`ProviderContextOverflowError`; 13 more tests —
`tests/retryregistry.test.ts` — no new runtime dependencies; TS-first
divergence documented in "Divergences from Python" below). Status
(2026-11-03, seventh note): robust workspace edits are shipped
(`src/workspace.ts` ports pi's `edit-diff.ts` + `file-mutation-queue.ts`,
MIT: exact match first for Python parity, then a whitespace/line-ending/
Unicode-normalized view, then an indentation-insensitive line block with
re-indentation; ambiguous matches fail with a line-numbered error unless
`replace_all`; BOM and the file's line endings are preserved, untouched
lines keep their bytes, and `makeDiff`/difflib parity is unchanged.
write/edit/delete of the same resolved path serialize through a
module-level per-path promise queue in call order — symlink-aware key,
reads lock-free; 12 more tests — `tests/editqueue.test.ts` — no new
runtime dependencies). Status (2026-11-03, eighth note): compaction v2 is
shipped (`src/compaction.ts` + the compaction paths in `src/harness.ts`,
per `research/pi-adoption.md` O3: split-payload cuts so an oversized
single delegation can no longer make a session uncompactable,
`<previous-summary>` incremental chaining with pi's update prompt,
`ProviderContextOverflowError` → one compact-and-retry, and a
`reserveChars` headroom below `thresholdChars`; 8 more tests —
`tests/compactionv2.test.ts` — no new runtime dependencies). Status
(2026-11-03, ninth note): compaction budgets can now be measured in
tokens (`src/compaction.ts` `estimateTokens` — a zero-dep chars/token
heuristic, ASCII 4:1, CJK/full-width/emoji 1 token per char, other
non-ASCII 2:1, rounded up; `CompactionSettings.contextWindow` /
`thresholdTokens` / `reserveTokens` default 2000 / `keepRecentTokens`;
token mode is selected deterministically when a window or an explicit
token threshold is set, else the char path is unchanged). Token mode
triggers at `(thresholdTokens ?? contextWindow) - reserveTokens`
estimated tokens and derives its auto budgets and summary cap in tokens;
cut selection, split-payload cuts and the 2000-char serialization caps
stay char-based. Overflow recovery sizes its compaction in tokens when a
window is known. CLI `--compact-threshold-tokens` / `--context-window`
(+ `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS` /
`TWO_BROTHERS_CONTEXT_WINDOW`); 15 more tests —
`tests/compactiontokens.test.ts` — no new runtime dependencies.
Per-preset context windows are the documented follow-up
(`docs/backlog.md`). Remaining for later goals: npm publish
mechanics (in progress — see [`handoff.md`](handoff.md) release-prep row), web.

## Intent

Port the Two Brothers harness from Python to a TypeScript npm-package
candidate at `packages/harness/` (npm workspace inside this repo). The
existing `typescript/` tree stays as the zero-dependency protocol reference;
this plan builds the *publishable* package from it and from
`python/two_brothers/`.

**Focus is code and functionality.** npm registry mechanics (final name,
`npm publish`, provenance) are a later goal; this goal ends when the
functionality is ported and proven.

## Locked decisions

| Question | Decision |
|---|---|
| Scope | Core + execution tier (below). Server/SSE, web, runtime manager, plugins: later goals. **MCP is now in scope and shipped** (`src/mcp.ts` + role-scoped tool registry, per BACKLOG "Role-scoped tool context" and the pi-mcp research verdict). (Product-shell module 1 adds the settings/secret stores — see below.) **The plugin system is now in scope and shipped** (`src/plugins.ts` — fail-soft loader + `PluginContext`, per BACKLOG "Plugins port"; per-role tool assignment consumes the same `toolScopes` registry as MCP). |
| Location | npm workspace `packages/harness/` in this repo; `typescript/` untouched as reference. |
| Package name | Working name `@two-brothers/harness`; final availability/name decided at publish time. |
| Runtime deps | **Curated, justified.** Allowed when they materially beat a hand-rolled equivalent; each recorded in the "Dependency ledger" below. Currently: `zod` (payload validation — the pydantic analogue), `@earendil-works/pi-mcp` (MCP client — the `mcp.py` analogue). Providers use global `fetch` (owned retry loop is a contract requirement; one client serves OpenAI/DeepSeek/OpenRouter/Ollama/vLLM). |
| Build | `tsc` → `dist/` (JS + `.d.ts`). Node type stripping cannot ship via npm (blocked under `node_modules`, no `.d.ts` for consumers). |
| Policy | Root `AGENTS.md` rule 2 + `typescript/AGENTS.md` rule 1 get a carve-out for `packages/harness/` only. |

## Dependency ledger

Runtime dependencies must stay curated; every entry needs a justification
here before it may be added.

| Package | Version | Justification |
|---|---|---|
| `zod` | 4.6.7 (exact) | Payload validation — the direct pydantic analogue (`payloads.py` parity); the sanitize/coerce tolerance layer is the highest-risk port, and declarative schemas make it verifiable. Chosen over hand-rolled validation for clarity. |
| `@earendil-works/pi-mcp` | 1.5.0 (exact) | MCP client (`src/mcp.ts` — the `mcp.py` analogue, role-scoped per the BACKLOG "Role-scoped tool context" requirement). Adopted per the research verdict (`research/harnesses/pi-durable-mcp-chord.md`): 3.3k LOC MIT, stdio + streamable-HTTP transports, in-memory transport pair for hermetic tests, correct client lifetime (connect once, hold for the run, idempotent close) — materially beats hand-rolling the JSON-RPC handshake, pagination, cancellation and spec-correct stdio shutdown (process-group kill, Windows `taskkill /T /F`). Pulls one transitive pure-JS dep, `cross-spawn@7.0.6` (Windows-correct process spawning; unavoidable, accepted). Note: pi-mcp declares `node >= 22.19` and the package engines now match it (`>=22.19`, Node 22 LTS baseline) — MCP transport paths need 22.19+. **1.5.0** is the pi upstream that fixes OAuth URL-scheme validation and an HTTP error-body leak, with no API break; the 1.4.0 → 1.5.0 bump keeps the same `McpTimeoutError` / `McpRequestOptions.timeoutMs` surface used by the hardening work. |

Not adopted, with reasons: `openai` SDK (the owned retry/backoff loop is a
contract requirement and one fetch client serves OpenAI/DeepSeek/OpenRouter/
Ollama/vLLM), `hono`/web framework (product-shell module 3 implemented
`server.py` on plain `node:http`: every route is a static prefix plus at most
one path parameter, SSE is a raw response stream, JSON body handling is ~15
lines, and static serving is `fs` streams — less total code than importing a
framework, and the runtime dependency list stays at zero new deps),
`node-dpapi` / native DPAPI modules (a child-process PowerShell
`ProtectedData` call keeps the runtime dependency list at zero; the
~100-300 ms per-spawn cost is amortized by batching every key of one
settings write into a single invocation). devDependencies (`typescript`,
`@types/node`) are unrestricted.

### Vendored code (no new dependencies)

| Source | License | Where | Notes |
|---|---|---|---|
| pi — `chord/src/output.ts` (github.com/earendil-works/pi) | MIT | `src/output.ts` (`boundOutput`, `sanitizeOutput`) | Bounded output windows + ANSI sanitizing. Not a copy: our own synchronous, character-based implementation (head+tail window with a middle marker matching the shell runner's style; escape-sequence/control-char regexes informed by pi's). Used to bound `read_file`/`search_text`/`list_dir` tool results and to strip terminal junk from shell output before the existing cap. Attribution comment at the top of `src/output.ts`. Zero new dependencies. |
| pi — `durable/src/harness/compaction.ts` + `coding-agent/src/core/compaction/compaction.ts` (github.com/earendil-works/pi) | MIT | `src/compaction.ts` (`selectCutPoint`/`selectCut`, `serializeConversation`, `SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`) | Context compaction for long sessions, ported per `research/harnesses/pi-durable-mcp-chord.md` + `research/pi-adoption.md` O3. Adapted, not copied: budgets measured in chars (deterministic; pi uses token estimates, and the reserve margin is a char count), envelope-atomic cut candidates (our protocol has no separate tool-result entries — evidence rides in payload fields) with the split applied inside an oversized envelope's serialization, the task head protected explicitly instead of pi's head pointer, incremental `<previous-summary>` chaining, and the summary carried as a marked `message` envelope so the protocol schema and session JSONL shape stay untouched. Both summarization prompts (cold + update) are verbatim pi's. Zero new dependencies. |

## Scope detail

In scope (Python source → TS target):

- `protocol.py` / `payloads.py` → `protocol.ts` + `payloads.ts`
  (envelope, tolerant `parse_model_output`, `sanitize_payload` with
  unknown-key drop / coercion / confidence clamp / verdict default).
- `transcript.py` → transcript rendering in `context.ts`
  (byte-stable `[[TASK]]`/`[[/TASK]]`/"Context events:" markers).
- `session.py` → `session.ts` (JSONL, flush-per-append, dense `seq`,
  resume without re-appending history, `SessionError` on corrupt lines).
- `config.py`, `prompts.py` → `config.ts`, `prompts.ts`
  (CLI > env > defaults; **fix `prompts.ts` to load from inside the package**,
  not `../../shared/`).
- `responders.py` → `provider.ts` (mock at parity; OpenAI-compatible fetch
  client with harness-owned retry loop `retries+1`, backoff 2/4/8/16/30s cap,
  abort-aware waits, per-attempt timeout, `UsageTracker` incl. cached tokens).
  Retry decisions go through the ordered `PROVIDER_ERROR_REGISTRY`: transport
  wording, 408/409/429 and 5xx retry; other 4xx, quota/billing exhaustion,
  context overflow and unclassified errors fail fast. Retryable responses
  honor `Retry-After` (delta-seconds or HTTP-date, capped at 120 s) in place
  of that attempt's backoff, and overflow payloads raise
  `ProviderContextOverflowError` (never retried).
- `graph.py` → `harness.ts` state machine: `senior_open → junior_answer →
  senior_verify(work, read-only tool slice) → senior_review → (junior_revise)*
  → senior_decide`; junior tool loop bound 8 iterations; evidence clipping
  into review/deliverable payloads; usage snapshot. `AbortController` replaces
  `threading.Event` cancellation.
- `coding.py` / `permissions.py` / `shell.py` → `workspace/` modules:
  confined read/list/search/write/edit/delete with unified diffs, symlink-aware
  root confinement, sensitive-path refusal **before** permission checks,
  fail-closed permission manager (no broker → deny; reads auto-allow);
  bounded shell runner (timeout, 20k output cap, cancel, process-tree kill
  `taskkill /F /T` on Windows / `killpg` POSIX).
- `cli.py` (run/chat/sessions/selftest) → `cli.ts`.
- `settings_store.py` / `secretbox.py` → `settings_store.ts` / `secretbox.ts`
  (product-shell module 1: per-role + provider-preset persistence with
  `api_key` sealed at rest, `dpapi1:` via a PowerShell `ProtectedData`
  child process on Windows / `plain1:` + 0o600 elsewhere, env-pinned
  `TWO_BROTHERS_*` values stripped before writes, write-then-rename,
  `public()` masking; no new runtime dependency).
- `runtime.py` / `runevents.py` → `runtime.ts` + extended `runevents.ts`
  (product-shell module 2: `RuntimeSettings` over the `SettingsStore`
  (`public()` masking, `apply()` overlays), worker-pool `RunManager` —
  default 2 workers (`TWO_BROTHERS_WORKERS`), FIFO queue, same-session
  serialization, typed events with `run_id`/`at`, cooperative stop via
  `AbortController`, in-memory records; `RuntimeEventStore` sidecars
  `sessions/runtime/<name>.events.jsonl` with torn-tail tolerance and
  traversal-safe naming; `RunApprovalBroker` implementing the
  `ApprovalBroker` interface — `respond(requestId, decision)` operator
  API, deny-on-stop, denyAll; no new runtime dependency).
- `server.py` → `server.ts` + `metadata.ts` + `workspace.ts` registry +
  `cli.ts serve` (product-shell module 3: FastAPI-compatible HTTP API for
  the Vue app — sessions CRUD + rename, `/api/stream` session tail SSE,
  background runs over the `RunManager` with the typed-event SSE
  (`?after=N` reconnect), operator approvals over HTTP, settings GET/PUT
  with masked `public()` output and env-pinned never-persist fields,
  provider presets, `/api/fs/browse` with Windows drive probing, static
  serving of `web/dist` (repo checkout) or the packaged `<package>/web` copy
  with SPA fallback, `{"detail": ...}` error bodies;
  plain `node:http`, no new runtime dependency). `metadata.py` →
  `metadata.ts` (`*.meta.json` sidecars, derived titles) and
  `workspace.py::WorkspaceRegistry` → `workspace.ts` (registered-never-
  scanned directories in `sessions/workspaces.json`).

Out of scope (later goals): web workspace, e2e
browser tests. **`plugins.py` parity is shipped** — `src/plugins.ts`: a
fail-soft `plugins/` loader (`[a-z0-9_]+` + `.ts`/`.mts`/`.mjs`, plain
dynamic `import()` with a `?v=N` reload cache-bust) importing once per load
and re-running `register(ctx)` against a fresh per-run `PluginContext`
bound to that run's `Workspace`; built-in tool-name collisions rejected at
registration and at run time (built-ins win); per-role assignment feeds the
`toolScopes` registry in `src/harness.ts` (senior scope joins the verify
slice unfiltered — the analogue of Python's `plugin_tools["senior"]` —
junior scope joins the junior belt); `GET /api/plugins` serves
`{plugins: [{name, description, roles}], errors: [{plugin, error}]}` and
per-role enable/disable rides `PUT /api/settings` `plugins` (python parity;
there is no POST /api/plugins) with `TWO_BROTHERS_PLUGINS_SENIOR/JUNIOR`
env overrides and a manager reload on plugins-carrying saves. TS
divergences (documented in the module header): plugin files are ES modules
not `.py`; `params_schema` is the tool's argument spec — a JSON Schema or
the Python `name -> type-name` shorthand (translated to string-typed
properties), since JS has no runtime signature introspection; no
module-docstring description fallback (an exported `description` string is
the stand-in); `toolsFor` is async (ESM import is); the example plugin is
`plugins/notes.mts`, the `notes.py` analogue. No new runtime dependency.
**`mcp.py` parity is shipped** — `src/mcp.ts` on `@earendil-works/pi-mcp`,
with role-scoped server assignment (`"role": "shared" | "senior" | "junior"`, default
"junior" to match Python's junior-only behavior) consumed by the
`toolScopes` registry in `src/harness.ts`. Hardened per pi's coding-agent
MCP adapter (`research/pi-adoption.md` §MCP): model-facing names are
`mcp__<server>__<tool>` (sanitized to `[A-Za-z0-9_]`, 64-char cap, stable
`_<8 hex>` sha256 suffix when truncated or when sanitizing collides),
with the raw pair preserved in `McpToolSet.displayNames` (`server/tool`)
and on each `McpToolEntry`; one result is clipped to 20 KiB
(`MCP_OUTPUT_MAX_CHARS`) through `output.ts`'s head/tail window with the
shell runner's truncation marker; every tool call passes a per-call
`timeoutMs` (default 60 s, per-server `"timeoutMs"` override in the MCP
config file) and a timeout returns an `MCP tool error: timed out …`
result instead of stalling the run. TS-first divergence: Python's
`mcp.py` exposes raw MCP tool names and has no result cap or per-call
timeout — MCP is a TS-port surface, so parity is not required.
**Context compaction is shipped (v2)** (BACKLOG "Context compaction") —
`src/compaction.ts`: pi's algorithm (`selectCutPoint`/`selectCut`,
`serializeConversation`, the pinned cold and update summarization prompts)
ported onto the envelope format; `CompactionSettings` (char budgets:
`thresholdChars` auto trigger capped so a compacted context lands under
the trigger, `reserveChars` reply headroom default
`DEFAULT_RESERVE_CHARS` = 8000 chars clamped to half the threshold,
`keepRecentChars` verbatim tail, `force` one-shot, `summarizerRole`
defaulting to the senior's provider) rides as `HarnessOptions.compaction`
and runs between state-machine nodes; a split-payload cut folds an
envelope larger than the keep-recent budget into the summary with
head+tail serialization and an explicit truncation marker, so one huge
delegation cannot make a session uncompactable; a previous summary in the
summarized prefix becomes `<previous-summary>` under pi's update prompt
(exactly one summary event survives); a `ProviderContextOverflowError`
from any provider call triggers one compact-and-retry against the rebuilt
context, and a second overflow surfaces. Fail-soft by contract (a
summarization failure warns via `result.warnings` / the `onWarning` hook
and keeps the full context, never crashing the run); the summary is a
`message` envelope marked by `COMPACTION_SUMMARY_PREFIX` (protocol and
schema untouched), the session store gains a temp-file + rename
`rewrite()` so compacted sessions resume like any other; CLI `--compact`,
`--compact-threshold <chars>`, `--compact-keep-recent <chars>` +
`TWO_BROTHERS_COMPACT*` env. **Token accounting** (Wave 3 sub-wave 3b)
adds `estimateTokens(text)` (zero-dep chars/token heuristic: ASCII 4:1,
CJK/full-width/emoji 1 token per char, other non-ASCII 2:1, rounded up),
`CompactionSettings.contextWindow` / `thresholdTokens` / `reserveTokens`
(default 2000) / `keepRecentTokens` (default 10000), and a deterministic
unit rule: tokens iff `contextWindow` or `thresholdTokens` is set, else
the char path above is unchanged. Token mode triggers at
`(thresholdTokens ?? contextWindow) - reserveTokens` estimated tokens,
derives the tail (≤ trigger/2) and summary (≤ trigger/4) budgets in
tokens, and caps the summary by estimated tokens; cut selection and the
split/serialization caps stay char-based. Overflow recovery uses token
budgets when a window is known. `ProviderConfig.contextWindow` carries
the run-level window for adapters to ignore; CLI `--context-window` /
`--compact-threshold-tokens` (+ env). Programmatic headroom exists but
no CLI flag for `keepRecentTokens`/`reserveTokens` yet. Divergences
(module header): token mode is estimator-based (a documented ±30 %
heuristic, not a tokenizer); envelope-atomic cut candidates (no
tool-result entries to split) — the split happens inside an oversized
envelope's serialization instead; the task head protected explicitly.
Per-preset context windows are a follow-up (context compaction, BACKLOG).
Python has no compaction — documented TS-first feature. No new runtime
dependency.

## Contract invariants (must hold in the port)

1. Transcript markers and rendered layout are byte-stable and identical to
   the Python output (both brothers receive the identical transcript string).
2. Boundary pipeline: structured attempt → single-attempt text fallback →
   fence-strip → brace-sniff → sanitize. Tolerant parse, strict validate,
   sanitizing bridge. `parse_model_output` never throws.
3. Session JSONL: one envelope per line, flush per append, dense `seq`
   derived from `len(events)`; resumed events are never re-appended.
4. Permissions fail closed; stopped run denies every parked approval.
5. Senior verify uses only the read-only tool slice; verify evidence rides in
   payload fields (`verify: …`, `tool: …`), never as extra envelopes.
6. Same-session runs serialize (envelope `seq` integrity) — in scope for the
   harness API even without the web runtime.

## Divergences from Python (TS-first)

Behavior the port intentionally owns differently from `python/two_brothers/`:

- **Provider retry classification** (`provider.ts`) — Python's
  `RetryingResponder.invoke` retries every exception and has no typed
  provider errors. TS classifies failures through `PROVIDER_ERROR_REGISTRY`
  (ported from pi-ai's `utils/{retry,provider-retry,overflow}.ts`):
  408/409/429/5xx and transport wording retry; other 4xx, quota/billing
  exhaustion, context overflow and unclassified errors fail fast. Retryable
  responses honor `Retry-After` (delta-seconds or HTTP-date, capped at
  120 s) in place of that attempt's fixed backoff, and overflow payloads
  raise `ProviderContextOverflowError` (never retried) so callers can
  compact. The retry budget itself is unchanged: 6 retries by default,
  2/4/8/16/30 s cap, abort-aware waits, per-attempt timeout, `--retries` /
  `--timeout` flags and env still apply.
- **Context compaction** (`compaction.ts`) — TS-only; Python has none.
- **MCP tool naming** (`mcp.ts`) — `mcp__<server>__<tool>` namespacing with
  a 64-char cap, a 20 KiB result cap and a per-call timeout; Python's
  `mcp.py` exposes raw tool names with neither cap nor timeout.

## Stages (the loop)

Port in this order; after each stage, port/extend that module's Python tests
and rerun the whole suite. Keep it green.

1. **Scaffold** — `packages/harness/`: workspace package.json, LICENSE copy,
   `tsconfig.build.json` (declaration, no tests), move `typescript/src` in,
   fix prompts path, author `src/index.ts` public API, AGENTS.md carve-out.
   **Done.**
2. **Protocol core** — protocol/payloads/context/session/config/prompts +
   tests from `test_protocol.py`, `test_session.py`. **Done.**
3. **Providers** — mock parity, OpenAI client with owned retry/backoff,
   cancellation, usage tracking; tests from `test_responders.py`,
   `test_retry_usage.py` semantics. **Done.**
4. **State machine** — full cooperation loop with tool loops, verify slice,
   revise bound, evidence clipping, usage snapshot; tests from
   `test_graph.py`. **Done.**
5. **Workspace execution** — coding tools, shell runner, permissions; tests
   from `test_coding.py` (+ permission/plugin-adjacent coverage). **Done.**
6. **CLI parity** — run/chat/sessions/selftest from the built `dist/`.
   **Done** (incl. `sessions` listing, shebang-verified bin, usage footer
   matching Python's `tokens:` line).
7. **Full verification** — whole suite, offline selftest, scripted mock
   run (consult + work with approvals), resume flow, smoke via packed tarball
   installed to a temp dir. **Done** (147/147 tests; output byte-identical to
   Python; seq dense 1..10 across resume; packed install + `npx` bin PASS).

## Risks / watch-list

- Sanitize/coerce tolerance must be reproduced exactly or real-model replies
  fail validation (biggest functional risk).
- Windows specifics: process-tree kill, bash probe (MSYS2 Git Bash), drive
  handling — port from `shell.py`/`test_coding.py`, verify on this machine.
- `Config.retries` exists in TS today but is unused — wire it into the
  provider retry loop.
- `mode: "auto"` is accepted but unimplemented in both implementations —
  leave as-is (out of scope), do not silently implement.
- Keep `typescript/` reference passing; smoke-test script runs both.
