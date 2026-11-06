# Backlog

Deferred work and design requirements, ordered by priority. Items here are
not in the active goal; pull them into goals or pick them up directly.
Update this file when an item ships or changes shape.

## Design requirements

### Role-scoped tool context (requirement for MCP + plugins)

> **Status: shipped for MCP and plugins** (`packages/harness`, 2026-11-01 /
> 2026-11-02; plugin scope opt-in 2026-11-04 — `toolScopes` registry in
> `src/harness.ts`; MCP per-server `role` in `src/mcp.ts`; plugins
> shared-by-default via `PluginManager.bindingsFor(activeNames, workspace)`
> feeding `toolsByScope`, `src/plugins.ts`). Per-role plugin scoping shipped
> as an explicit per-tool opt-in; shared-by-default stands as the product
> decision (owner decision 2026-11-03).

MCP servers and plugins must be assignable per role, in three scopes:

- **shared** — tool/context visible to both brothers at once (e.g. a
  shared memory tool both can read and write).
- **senior-only** — e.g. verification aids the junior must not see.
- **junior-only** — e.g. destructive workspace operations reserved for
  the delegated worker.

Design anchors that already exist:

- `packages/harness/src/harness.ts`: junior `tools` belt + `seniorTools`
  (joins the verify slice unfiltered today) + verify-time read-only
  filtering via `SENIOR_VERIFY_TOOL_NAMES`. Generalize this into an
  explicit role-scoped tool registry (shared / senior / junior) instead
  of ad-hoc parameters.
- Historical baseline: the original prototype's plugin module did per-role
  plugin assignment, and its MCP client was junior-only — the TS port was to
  support all three scopes for MCP from the start, not copy the junior-only
  limitation. (Shipped in the TS package: MCP servers take an optional
  `"role"` field, default `"junior"` so plain configs keep the junior-only
  behavior.)
- Tool context (not just the tools themselves) follows the same scoping:
  a shared memory tool sees the same store from both roles; per-role
  tools stay isolated per role.

## Later goals / items

- **npm publish prep** — verify `@two-brothers/harness` name availability
  (fallbacks), publishConfig + provenance (OIDC), `publint`/`attw` gates,
  and pi's supply-chain practices (exact-version pins + check script,
  lockfile-commit guard, AST runtime-deps check, tarball-install smoke
  into temp consumers, per-package CHANGELOG with `[Unreleased]`).
  **Shipped 2026-11-02** — `publishConfig` (public + provenance), `pack:check`
  (`publint` + `attw`), the `scripts/check-*.mjs` + `tarball-smoke.mjs`
  checks, `.husky/pre-commit` lockfile guard, `packages/harness/CHANGELOG.md`,
  and `.github/workflows/publish.yml` (OIDC Trusted Publisher, `--tag next`)
  all landed (see `docs/history/handoff.md`, TypeScript npm-package port section). The
  one-time npm org / Trusted Publisher linkage described in the workflow
  still has to happen before the first `v*` tag push.
- **Plugins port** — the original prototype's `plugins/` loader (`register(ctx)`
  contract, `PluginContext` with confined workspace helpers, fail-soft loader)
  as an npm-shareable format. Borrow chord's discovery manifest-checklist
  and esbuild-bundle-per-plugin-with-external-host-packages patterns
  (research/harnesses/pi-durable-mcp-chord.md); keep our `register(ctx)`
  contract; plain dynamic `import()` loader for single-process use.
  **Shipped 2026-11-02** — `src/plugins.ts` (loader + `PluginContext` +
  `PluginManager`), shared-by-default assignment into the `toolScopes`
  registry (one settings list; every plugin tool works for both brothers,
  owner decision 2026-11-03 — per-role scoping moved to its own backlog
  item below), real `GET /api/plugins`, settings-`plugins` enable/disable
  with deprecated per-role env aliases, example `plugins/notes.mts`; no
  new runtime deps (see `docs/history/ts-rewrite-plan.md` for the documented TS
  divergences).
- **Per-role plugin scoping** — **Shipped 2026-11-04 (capability; the
  shared-by-default product decision stands).** `ctx.add_tool(name,
  handler, { scope: "shared" | "senior" | "junior" })` opts a tool into one
  belt; `effectiveToolScope` keeps a legacy positional `role` (and any tool
  with no explicit scope) shared, `RegisteredTool.scope`/`scopeSource`
  record provenance, `PluginManager.bindingsFor` buckets tools into
  `toolsByScope`, and the server/CLI merge those buckets into the run's
  `toolScopes` (junior belt = shared + junior; senior verify slice =
  shared + senior). Provenance kept so existing plugin sources change
  nothing. Settings stay one shared plugin list — no per-role
  enable/disable UI, by design. Tests: `tests/plugincore.test.ts`,
  `tests/integration.test.ts`.
- **Context compaction** — re-implement pi-durable's compaction
  algorithm (`selectCut`, `serializeConversation`, summarization prompt,
  ~150 LOC of logic) onto our envelope format for long sessions
  (research/harnesses/pi-durable-mcp-chord.md).
  **Shipped 2026-11-02** — `src/compaction.ts` (cut-point selection,
  transcript serialization with the 2000-char cap, pi's pinned
  summarization prompts verbatim, char-budget policy in
  `CompactionSettings`), wired into the harness loop as
  `HarnessOptions.compaction` (auto trigger between nodes at
  `--compact-threshold <chars>`, one-shot `--compact`, fail-soft with a
  warning), CLI flags + `TWO_BROTHERS_COMPACT*` env vars, session-store
  rewrite (temp-file + rename) so compacted sessions resume like any
  other; the summary rides as a marked `message` envelope (protocol
  untouched). The original prototype had no compaction — a documented TS-first
  divergence; 14 tests, no new runtime deps (see
  `docs/history/ts-rewrite-plan.md`).
- **Print/JSON automation mode** — pi's `print-mode.ts` pattern (~170
  LOC): non-interactive `run --json` event stream for scripting/CI
  (research/harnesses/pi-product-shell.md).
  **Shipped 2026-11-02** — `run --mode print|json` / `--json-events` on the
  TS CLI (decision-only stdout / one machine-readable object, diagnostics on
  stderr, exit 0/1/2); output bounding below shipped in the same stage.
- **Multi-provider fetch adapters** — Anthropic/Gemini `Provider`
  implementations informed by pi-ai's wire/usage mapping
  (`api/anthropic-messages.ts`, `api/google-shared.ts`), preserving the
  owned 2/4/8/16/30s retry + `UsageTracker` contracts byte-for-byte
  (research/harnesses/pi-ai-agent.md).
  **Shipped 2026-11-03** — `AnthropicProvider` + `GoogleProvider` in
  `src/provider.ts` behind `ProviderKind` (`openai-compatible` default;
  `--provider-kind`/`--senior-kind`/`--junior-kind` + env; preset `kind`
  rides `RoleEndpoint` to the adapter on the server path). Error
  classification rows added for both families (retryable overloads /
  fatal rejected rows / overflow shapes -> `ProviderContextOverflowError`);
  usage mapped per family (Anthropic cache-read, Gemini cached-content
  math). 29 hermetic tests in `tests/adapters.test.ts`; the
  OpenAI-compatible path is byte-stable. Follow-ups: ~~`--max-tokens` flag
  (Anthropic output cap is a constant 4096 today)~~ **shipped 2026-11-04**
  (`Config.maxTokens`/`maxTokensForRole`, per-role env overrides, forwarded
  on the endpoint/server path too — see "Shipped 2026-11-04" below);
  live-endpoint smoke needs provider keys.
- **Output bounding** — vendor chord's `output.ts` (bounded head/tail
  windows + ANSI/control-char sanitize) for tool output before it enters
  JSONL stores/transcripts (zero-dep, MIT).
  **Shipped 2026-11-02** — `src/output.ts` (20k head+tail read window,
  20k search aggregate, 400-entry list cap, ANSI sanitize-first) applied
  to the workspace tool results.
- **Telemetry contracts** — pi-telemetry's explicit-context shape
  (typed metrics, in-memory impl, no-op default); skip a package dependency,
  copy the shape. (The server + runtime manager this was waiting on have
  shipped in `packages/harness` — product-shell modules 2–3.)
- **Web-run status contract polish** (from the Wave-1 web UI work,
  2026-11-02): (1) emit `run_status: waiting` on the SSE stream so the UI
  needs no 2 s poll to show approval-parked runs; (2) expose `mode` on
  `RunRecord` so a reloaded failed run can be retried with its exact
  original mode; (3) persist the terminal run error (runtime sidecar or
  session metadata) — run records are in-memory, so a backend restart
  still loses the inline error after reload.
  **Shipped 2026-11-02** — `packages/harness` only, protocol envelopes
  untouched: `RunManager` emits `run_status: waiting` after
  `approval_requested` (and `run_status: running` after
  `approval_resolved`) via the existing typed-event buffer/sidecar;
  `RunRecord.mode` carries the request's mode (or the resolved config
  default) through `POST /api/runs` → `GET /api/runs[/{id}]`; a failed
  run's error survives a restart because `GET /api/runs/{id}` falls back
  to `RuntimeEventStore.findRun()` and rebuilds a minimal terminal record
  from the per-session sidecar (`task`/`mode` are not event fields and
  come back as ""). The web UI dropped its 2 s followed-run
  `probeFollowedRun` poll and the client-side `waiting` patch on
  `approval_requested` (the stream carries the state) — shipped 2026-11-03
  in `8a196cb`, verified 10/10 browser E2E; the 5 s pool poll
  stays for adopting unattended runs.
- **Prompt sections: tool-use instructions per role** (from the first
  real-model E2E against LM Studio, 2026-11-03, `lfm3-1.7b` junior +
  `spark-x2.6-4b@q4_k_m` senior): in `--mode work` the junior received the
  workspace tool belt but never invoked a tool — it hallucinated the
  directory listing instead (reported `README.md, main.py, notes.txt` for
  an actual `app.py, notes.md`), so the delegated file write never
  happened. Root cause verified in `shared/prompts.json`: neither the
  senior nor the junior system prompt mentions tools at all (0
  occurrences), so small models answer from the transcript text instead
  of using the attached tools. Fix is part of the planned structured
  prompt-sections work (Wave 2 sub-wave B2): an explicit available-tools
  section per role plus a use-these-tools directive on delegated
  (deliverable) turns. Note the harness degraded honestly throughout —
  sanitize-fallback warnings on all four nodes and exit code 1 from
  `result.errors`, no crash.

  **Shipped 2026-11-03** — `packages/harness` only, `shared/prompts.json`
  (both copies) byte-identical and protocol envelopes untouched:
  `harness.ts::assembleSystemPrompt` appends pi-style `## Available tools`
  (the call's actual model-facing belt — MCP namespacing applied, one line
  per tool; "You have no tools; answer from the transcript." when empty)
  and `## Using tools` to the role's base prompt, and the junior's
  work-mode deliverable message carries `DELEGATION_DIRECTIVE` after the
  byte-stable transcript. Every provider call now records a
  `PromptAuditEntry` (role, node kind, section names, tool names,
  system/user char lengths only) on `HarnessResult.promptAudits`;
  `--verbose` prints the trail. **Follow-up shipped (same day):** the
  audit is also a `prompt_audit` typed runtime event, emitted right
  before each call, so `two-brothers serve` SSE consumers (the web
  workspace timeline) see it live; additive only — the event
  store/sidecar, protocol envelopes and the schema are untouched.
  Tests: `tests/promptsections.test.ts`, `tests/server.test.ts`, and
  the hermetic `e2e/server-prompt-audit.ts`. Real-model re-check
  against LM Studio (2026-11-03, `lfm3-1.7b` junior + MCP filesystem
  server, work mode): the junior listed the real directory via
  `mcp__filesystem__list_directory`, recovered from a confinement-denied
  first write, wrote the deliverable file, and recorded `tool:` evidence
  in the deliverable exactly as the sections direct — no hallucination
  (pre-fix baseline had it inventing file names). Node payloads still
  sanitize-fallback on these small models (their own recorded gap).

## New items (2026-11-03, from the spark frontier-model runs)

- **Structured-payload discipline (the strict-parse gap)** — evidence from
  every real model tested so far: `lfm3-1.7b` and `spark-x2.6-4b` (LM
  Studio) and the frontier `spark-x2.6` (xhtoken, 2026-11-03) ALL emit node
  payloads outside the strict parser, so every node records
  "unstructured model reply" and a real run exits 1 — even though the
  sanitize bridge produces good decisions (a spark consult run correctly
  refused to invent project facts with no tools and asked for a file
  listing instead). The cooperation loop works; the strict payload
  contract is what no model meets. Candidate fixes, in preference order:
  (1) a **repair pass** — feed the strict-parser violation back and re-ask
  once per node (pi-style), keeping sanitize as the last resort;
  (2) **relaxed strict parse** — accept bare JSON objects / fenced blocks
  without the byte-stable markers when they validate against the zod
  schema (markers stay for byte-stable transcript rendering);
  (3) **few-shot payload exemplars** appended to the section assembly.
  Note: `--max-rounds` interplay must stay bounded so a repair attempt
  cannot loop the revise cycle.

  **Shipped 2026-11-04 — fixes (1) repair pass + (3) few-shot exemplars**
  (`packages/harness` only; protocol envelopes, the schema and
  `shared/prompts.json` untouched): every structured node reply (`consult`,
  `proposal`, `delegation`, `deliverable`, `review`, `decision`) is checked
  against the strict zod schema after the tolerant parse; a failure gets
  exactly ONE repair re-ask. The repair turn is a marked `message` envelope
  from "user" (`[[REPAIR_REQUEST]]` … `[[/REPAIR_REQUEST]]`, the
  compaction-summary convention) appended to the shared context and the
  session JSONL, and the request resends the conversation OpenAI-style (bad
  reply as an assistant turn, repair instruction as a user turn) with the
  zod issue paths/messages clipped to ~500 chars. A still-bad reply falls
  back to sanitize + defaults + the one existing "unstructured model reply"
  warning — the tolerant boundary never throws, and the repair never touches
  `--max-rounds`. Each role's kind-specific system-prompt assembly also
  appends one tiny, strict-valid fenced payload example per kind (the audit
  section names stay stable). Adjacent fix needed by the repair path:
  `toolLoop` now returns the model's final reply — it used to return the
  last conversation message (the last tool result, or the prompt itself), so
  a structured deliverable was discarded whenever a tool ran. Tests:
  `tests/payloadrepair.test.ts`. **Follow-up fix (2) relaxed strict parse —
  shipped 2026-11-04** (`relaxedStrictPayload` in `src/payloads.ts`, checked
  before the repair re-ask): a reply that is a bare JSON object or a fenced
  block without the byte-stable markers is accepted when it passes the same
  strict zod validation — extraction is relaxed, the schema is not (markers
  stay for byte-stable transcript rendering). Tests:
  `tests/relaxedparse.test.ts`.

## Shipped 2026-11-04 (Wave 4 feature lanes + integration)

- **Payload repair + exemplars** (S1) — see the strict-parse item above:
  one marked repair re-ask per structured node, `PAYLOAD_EXAMPLES`
  few-shot block per kind, `toolLoop` final-reply fix. Exports:
  `REPAIR_REQUEST_PREFIX/SUFFIX`, `REPAIR_ISSUE_CHARS`,
  `STRUCTURED_PAYLOAD_KINDS`, `strictPayloadIssues`, `buildRepairRequest`,
  `PAYLOAD_EXAMPLES`.
- **Plugins v2** (S2a) — per-tool scope opt-in, typed fail-soft hooks
  (`session_start`/`session_end`/`before_tool_call`/`after_tool_call`,
  monotonic deny), dispatch-time argument validation
  (`toolschema.ts`), per-tool timeouts, per-plugin `{path, options}` +
  `configSchema`, manifest, `bindingsFor` and diagnostics. Plugin tools
  now route to the senior/junior belts per scope; legacy positional roles
  stay shared. See `docs/plugins.md`.
- **Skills system** (S2b + integration) — `src/skills.ts`:
  `discoverSkills` over `SKILL.md` trees and loose `.md`, hand-rolled
  frontmatter (`name`/`description`/`scope`/`tools`), role scoping
  (`shared`/`senior`/`junior`), `renderSkillsSection` (pi-style
  `## Available skills`) and `renderSkillBody`. `HarnessOptions.skills`
  adds the section + one invocation line to the assembled prompt only for
  roles that have skills; `--skills-dir` / `TWO_BROTHERS_SKILLS_DIR` /
  `<cwd>/skills` / `~/.two-brothers/skills` are the roots; the server
  serves metadata at `GET /api/skills`. A `<skill name="…">` request in a
  structured reply injects the body once as a `<skill-loaded>` message
  (`deliverSkillRequest`; at most three per run, each skill once, only
  skills visible to the acting role).
- **Onboarding** (S2d + integration) — seeded provider presets
  (`src/presets.ts`; env-var key names only), `mergeSeedPresets` layered
  under stored presets in `GET /api/providers` / `provider_ref`
  validation / endpoint resolution / preset edits, `two-brothers models`
  (`provider.listModels()`), and `two-brothers onboard` (interactive or
  `--non-interactive`, piped-stdin safe) writing per-role settings.
- **Cost visibility** (S2d) — `src/cost.ts` price table +
  `estimateCost`/`priceForModel`; `run` prints a `cost:` line when both
  roles share one priced model; `--mode json` carries `cost`.
- **`--max-tokens`** (S2d + integration) — run-level and per-role output
  caps forwarded by the CLI's providers and by `providerFromEndpoint`.
- **CLI + server integration** — `run`/`chat`/`serve` load plugins
  (`--plugins-dir`, `TWO_BROTHERS_PLUGINS_DIR`, default `<cwd>/plugins`,
  fail-soft, verbose-only diagnostics), merge plugin scopes into
  `toolScopes`, pass hooks into `HarnessOptions`, and build the skills
  catalog; the server switches to `bindingsFor`, passes hooks + skills to
  every run, exposes `GET /api/skills` and additive `/api/plugins`
  `diagnostics`, and applies per-plugin options via `setSettings` before
  the reload. Tests: `tests/integration.test.ts`; every suite is now
  registered in `tests/run-all.ts`.

## Shipped 2026-11-04 (Wave 4, S3a — streaming run events)

- **Streaming run events + `run --stream`** — `packages/harness/src/runstream.ts`
  is the in-process NDJSON vocabulary behind `HarnessOptions.onStreamEvent`:
  `run_status` (started / completed / failed / cancelled), one `envelope`
  per appended envelope, `repair`, `tool_call` / `tool_result`
  (`ok` / `error` / `blocked`), and a terminal `result` (decision, usage,
  warning count, session file). Commit-point-only emission (no token
  streaming — records come from state the harness already reached),
  bounded lines (`STREAM_FIELD_CHARS` 8192 / `STREAM_LINE_CHARS` 32768,
  chars not bytes), `toNdjsonLine`, and CLI `run --stream` (its own output
  mode; `--json`/`--mode print|json` conflict exits 2; the human summary
  and cost line are suppressed). Design from
  `research/harnesses/plugins-deepseek-harness.md` §R3. Tests:
  `tests/streaming.test.ts`. See `packages/harness/CHANGELOG.md`
  `[Unreleased]`.

## Shipped 2026-11-04 (consumer journey fixes)

- **Bare `run --json` is an output mode** — `resolveOutputMode` treats
  `--json` without an explicit `--mode print|json` as `--mode json`
  (one `{task, events, decision, usage, cost, rounds, errors}` object),
  no longer the human transcript plus a final decision line. `--mode
  print --json` keeps its decision-object behavior; `--help` documents
  `--json` separately from `--verbose`.
- **Approval-deny repeat cap** — per run, `(action, target)` pairs for
  the workspace mutation tools are counted on `status: "denied"` results;
  after `APPROVAL_DENY_LIMIT` (2) operator denials the next identical
  request is auto-denied in `invokeTool` before the workspace's
  `PermissionManager` broker is reached. Different targets/actions still
  ask. The cap uses the workspace's `denied` result shape (+
  `auto_denied: true`). Tests: `tests/approvaldeny.test.ts`. **Scope
  note:** the cap lives in the harness's built-in workspace-tool path;
  approvals requested by plugin/MCP code through the same broker are not
  capped (see the open item below).
- **Provider timeout warnings** — one `[warn] … retrying (attempt k/n)
  — consider --timeout for slow models` per timed-out retry, stderr only,
  at most `MAX_TIMEOUT_WARNINGS` (3) per provider instance and three per
  CLI run; visible without `--verbose`; `serve --help` documents
  `--timeout`. Tests: `tests/providerwarnings.test.ts`.
- **`rebuilt` marker on recovered runs** — `GET /api/runs/{id}` sidecar
  fallback returns `"rebuilt": true`; live records omit it. Tests:
  `tests/server.test.ts`.

## Shipped 2026-11-06 (search/export, TUI find, workspace order, TUI styling, broker cap)

- **Session search and export** — `src/sessionsearch.ts` (search over titles +
  payload text, Markdown/JSON exporters, fail-soft corpus loading),
  `sessions search`/`sessions export` on the CLI, `GET /api/search` and
  `GET|HEAD /api/sessions/{name}/export` on the server, Ctrl+K content search
  and row export in the web workspace. See `docs/cli-reference.md`.
- **TUI find-in-transcript** — `Ctrl+F` / `/find [query]`, inline bar with
  wrap navigation, gutters and scroll-to-block; `src/tui/view/findbar.ts`.
- **TUI span-level Markdown emphasis** — `src/tui/markdownstyle.ts` styled
  lines/spans + `Theme.paintEmphasis`; `plainTheme`/`NO_COLOR` output stays
  byte-identical. This closes the long-deferred "inline emphasis styling"
  item.
- **Workspace rename and operator ordering** — `WorkspaceRegistry.rename()` /
  `reorder()`, `PATCH /api/workspaces/{id}` and
  `PUT /api/workspaces/order`, plus the web sidebar actions menu (rename
  dialog, move up/down, optimistic reorder).
- **Broker-level approval-repeat cap** — see the open-items note above; the
  broker now covers plugin/MCP approval consumers and emits an additive
  `approval_auto_denied` event.

## Shipped 2026-11-07 (composer mentions, live thinking streaming)

- **Composer mentions and slash commands** — `src/mentions.ts` (token
  scanning/blocks/path normalization), `src/workspacefiles.ts` (bounded file
  index + picker ranking), `GET /api/workspaces/{id}/files`, run-submission
  slash expansion and `@skill:`/`@file` context injection in the server, web
  composer `@`/`/` pickers, TUI `/` and `@skill:` pickers with injection. See
  `docs/cli-reference.md` → "Composer mentions and slash commands".
- **Thinking/response streaming** — provider reasoning deltas
  (`ChatOptions.onThinkingDelta`, OpenAI-compatible/Anthropic/Google
  adapters), harness/runstream `token.kind`, `POST /api/runs
  {"stream_tokens": true}` with named ephemeral SSE `event: token` frames,
  web live Thinking/Response blocks and the TUI live `THINKING` block. See
  `packages/harness/CHANGELOG.md`.

## Open items (deferred)

- **Reasoning persistence and passback** — thinking/reasoning deltas are
  currently observational and live-only: they are not persisted, not
  replayable after a reload/reconnect, and not passed back to providers on
  tool-loop turns. Two follow-ups: (1) persist an additive reasoning summary
  in the runtime sidecar (or a protocol field, which would be a contract
  change) so the thinking block survives reload; (2) Anthropic extended
  thinking with tool use expects signed thinking blocks passed back on
  assistant turns — capture and replay them in the Anthropic adapter if
  thinking-enabled tool loops are offered as a supported configuration.
- **TUI file mentions** — `@file` mentions need a workspace-bound TUI run
  path; today terminal runs have no workspace, so `@relative/path` stays
  literal task text.
- **`TWO_BROTHERS_JSON` vs bare `--json`** — the flag is now an output
  mode (the `--mode json` object), while the env var keeps its
  `PROTOCOL.md` contract (decision as JSON on the last line, after the
  transcript). Align the env var with the flag — or document the split in
  `docs/cli-reference.md` — once `PROTOCOL.md` (the contract owner
  for the env var) is updated.
- **Approval repeat cap at the broker** — **shipped 2026-11-06**:
  `RunApprovalBroker` counts operator denials per identical
  `(action, normalized target)` pair and auto-denies the next identical
  request after `APPROVAL_DENY_LIMIT` (default 2), emitting one additive
  `approval_auto_denied` runtime event instead of parking the run. The
  harness-level workspace-tool cap is unchanged and preempts the broker for
  the built-in tools, so the two layers cannot double-count; the broker cap
  covers plugin/MCP approval consumers. See
  `tests/approvalbrokerdeny.test.ts` and `packages/harness/CHANGELOG.md`.
- **Relaxed strict parse** — **shipped** (payload fix 2, 2026-11-04):
  bare/fenced JSON that validates against the zod schema is accepted without
  the byte-stable markers (`relaxedStrictPayload`,
  `tests/relaxedparse.test.ts`); markers stay for transcript rendering. See
  the strict-parse item above.
- **Streaming responses** — S3 lane, **shipped**: run-level
  events (envelopes, repairs, tools, status) ship as NDJSON /
  `onStreamEvent` (see the S3a shipped section above), and
  `run --stream --stream-tokens` adds one `token` record per provider text
  delta (the TUI renders those deltas in place). Additive only — protocol
  envelopes are unchanged.
- **Plugin-contributed MCP servers** — **shipped**: `ctx.add_mcp_server`
  plus an exported `mcpServers` object feed `PluginBindings.mcpServers`,
  merged under the `--mcp-config` base (see `docs/plugins.md`).
- **Slash commands** — **shipped**: flat `<root>/<name>.md` prompt
  templates in the chat REPL and the TUI (`--commands-dir`), metadata at
  `GET /api/commands` (see `docs/cli-reference.md`).
- **TUI** — **shipped**: `two-brothers tui` is a zero-dependency
  full-screen chat in the terminal over the same runtime events.
- **Subagents** — spawning nested cooperation runs (and likely child
  sessions) beyond the two-brother senior/junior pair. The context and
  approval machinery are the prerequisites; not started.
- **Stacked-dialog mask-click (web, non-blocker)** — naive-ui fires
  `mask-click` for clicks that land inside a stacked second dialog, so
  every dialog's handler must ignore those via the `web/src/modal.ts`
  guard. Revisit when upstream fixes the stacked-dialog semantics (or
  replace the guard with upstream support).
- **vue-tsc 3.3 follow-up (web, non-blocker)** — the `~3.0.2` pin
  (2026-11-04 security update eliminating the minimatch advisory) stays
  until vue-tsc 3.3's template-scope handling is verified; then bump and
  re-check `npm run build`.
