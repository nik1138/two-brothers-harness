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

- **Crash-torn session resume (vendor scout F3)** — the pi/opencode scout
  reported that a session file whose last JSONL line was half-written when the
  process died is not resumed cleanly; the reference fix is to truncate to the
  last complete line and say so once. Reproduce hermetically first (write a
  session, cut the final line mid-object, `--resume`), then make the reader
  drop the torn trailing record instead of failing the session, keeping dense
  `seq` intact and never rewriting the file behind the operator's back.
  **Shipped in wave 25 (2026-11-08):** a read ignores only a torn *trailing*
  record in memory (reported once; the search document carries additive
  `recovered`/`dropped_bytes`), `--resume` repairs the file atomically before
  appending with dense `seq`, interior corruption stays a typed error, and
  read-only listing/search/export never rewrite. The brief above is kept for
  context. **The recover-vs-refuse policy question is settled:** recover the
  torn trailing record, never guess at interior corruption, and keep read-only
  paths read-only; destructive rewind keeps the strict reader and refuses
  before rewriting.
- **Detached POSIX children on TUI shutdown (vendor scout F4)** — shipped in
  wave 24 for the cooperative paths: the TUI now waits for the running turn to
  unwind `run_shell`'s kill/drain (bounded by the shared
  `SHELL_DRAIN_BUDGET_MS`) before restoring the terminal, and plugin tools
  receive the run's abort signal with `ctx.workspace_shell` forwarding it, so
  a cancelled plugin-initiated shell is cancellable. CLI per-turn abort and
  SIGINT/SIGTERM/SIGHUP coverage shipped in wave 25 (`src/turnsignal.ts`, exit
  codes 130/143/129, bounded drain wait); TUI steering shipped as `Ctrl+N`.
  Remaining: real POSIX hardware validation of `killpg` when the leader already
  exited (this machine is Windows; the Windows tests prove abort/drain
  propagation only).
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
  **Persisted compaction settings shipped in wave 25 (2026-11-08):** the
  top-level `compaction` section of `sessions/settings.json` stores
  `threshold_chars`, `threshold_tokens`, `keep_recent_chars` and
  `context_window`; `GET/PUT /api/settings` carry it additively (per-field
  `{persisted, effective, source}` plus `force`/`pinned`) and the web
  Settings → Advanced **Auto-compaction** card edits it. Precedence:
  explicit `ServerOptions.compaction` > an explicitly-set non-zero CLI/env
  field (provenance-tracked, so the 40 000 keep-recent default never shadows a
  saved value) > persisted > absent, with `0` meaning off/unknown.
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
  `--max-rounds`. Each role's kind-specific prompt assembly also appends one
  tiny, strict-valid fenced payload example per kind (wave 30 moved this block
  from the system prompt to the transcript user turn; the audit section names
  stay stable). Adjacent fix needed by the repair path:
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

## Shipped 2026-11-07 (first-party base commands + command-surface cleanup)

- **Base-command catalogue** — `src/basecommands.ts`: the built-in slash
  commands adapted from deepseek-harness's six builtin identities and
  kimi-code's TUI slash-command registry, split into `prompt` templates
  (`plan`, `goal`, `feedback`; literal `$ARGUMENTS` expansion, `consult` mode,
  `requiresArguments` usage errors) and `action` commands a surface performs
  (`compact`, `export`, `permission`, `status`, `mode`, `new`, `help`).
  English + reference Chinese aliases, priority ordering, serializable
  metadata for `GET /api/commands`; a discovered `<name>.md` shadows a base
  name. `expandTemplate` is shared with discovered commands so both render
  identical task bytes.
- **Server** — additive `baseCommands` in `GET /api/commands`; base prompt
  expansion + mode override and an actionable 400 for action commands in run
  submission (both `POST /api/runs` and legacy `/api/run`);
  `POST /api/sessions/{name}/compact` for on-demand compaction (404/400/409/
  honest no-op/502, dense-`seq` in-place rewrite). See
  `docs/cli-reference.md` → "Built-in commands".
- **Web** — built-in group in the composer `/` menu (priority order, action
  badges, alias/description search, discovered-shadows-base, old-backend
  fallback), local action dispatch (compact via the new route with reload,
  export via the shared download, help/status/permission dialogs, mode, new),
  a commands & shortcuts overlay (`/help`, `?`, `Ctrl/⌘+/`), the composer key
  contract (IME/repeat-safe submit, `Ctrl/⌘+Enter`, picker `Tab`/`Shift+Tab`,
  `Esc` layering) and 500 ms double-`Esc` stop.
- **TUI** — built-in commands in the `/` picker and help overlay with honest
  local actions (compact/export/status/permission, refusals where a surface
  cannot act), native keymap commands still winning, picker grouping/badges/
  alias search/hint footer, and `Tab`/`Shift+Tab` accept/dismiss in the
  pickers.
- **CLI** — the `chat` REPL dispatches prompt commands (plan/goal/feedback
  with mode override and usage errors) and performs `/compact`, `/export`,
  `/status`, `/permission`, `/mode`, `/help`/`/commands` locally; `/new` is
  refused with guidance; `help chat` documents the surface.

## Shipped 2026-11-07 (provider reset, folded tool previews)

- **Provider preset reset-to-default** — `POST /api/providers/{name}/reset`
  removes only a customized built-in seed's stored override (legacy
  case-variant duplicates included), keeps both roles' `provider_ref`,
  unrelated settings/plugins and other providers, and returns the canonical
  seed (`seed: true`, `customized: false`). Errors: unknown name 404, custom
  (non-seed) provider 400, pristine seed/no stored override 409
  (`provider is not customized: <name>`). `DELETE` keeps its existing
  remove-and-clear-refs behavior. The web Settings → Providers master–detail
  card shows **Reset to default** only for a customized built-in seed, with a
  confirmation that the stored override (including its API key) is discarded
  while Senior/Junior assignments stay; against an older backend without the
  route, the client shows an unsupported message and changes nothing. Tests:
  `tests/server.test.ts`, `web/tests/providerSettings.test.ts`. See
  `docs/cli-reference.md` and `docs/quickstart.md`.
- **TUI folded tool-result previews by visual rows** — a collapsed tool row
  now keeps the first `maxToolRows` (default six) visual rows after
  width-aware wrapping instead of raw logical lines, so one long line cannot
  fill the screen; the `… +N more lines` marker counts hidden visual rows.
  `Ctrl+T` still toggles the most recent result between the preview and its
  complete text; expansion remains per tool row, and the model keeps the full
  result. The visual-row truncation follows pi's visual-truncate approach
  (MIT); reimplemented locally with no substantial block copied (NOTICE
  unchanged).
  Tests: `tests/tuivisualmodel.test.ts`. See `docs/cli-reference.md` and
  `docs/quickstart.md`.

## Shipped 2026-11-07 (provider discovery, queue visibility, session approvals, terminal polish)

- **Provider model discovery** — `POST /api/providers/{name}/discover` probes
  the current draft (additive `base_url`/`kind` and a one-shot typed `api_key`;
  the stored/env-backed key is used only when the draft URL is the preset's own
  endpoint) through `provider.ts::listModels` and returns
  `200 {models, base_url, kind}`. It never persists or applies anything, never
  stores/echoes the typed key, treats an empty list as a valid answer (a saved
  catalog is never erased), and answers 404 for an unknown provider, 400 for an
  invalid body or an unsupported wire kind, and 502 for an upstream failure;
  only OpenAI-compatible endpoints expose a `/models` listing. Settings →
  Providers gains **Refresh models** with
  loading/ready/empty/error/unsupported states, a monotonic stale-token guard,
  an explicit **Add N to draft** (Save changes still required) and old-backend
  fail-soft (404 → unsupported message, nothing changed). Files:
  `src/server.ts`, `web/src/providerSettings.ts`,
  `web/src/components/settings/ProvidersSection.vue`; tests
  `tests/server.test.ts` (discovery section, hermetic loopback) and
  `web/tests/providerSettings.test.ts`. The offline path stays
  `two-brothers models --base-url <url>`.
- **Queue visibility (web)** — the composer stays usable while a run works:
  the send control reads **Queue**, `POST /api/runs` accepts the submission
  behind the session's FIFO with `status: "queued"`, and a bounded queue dock
  above the composer lists `#N` positions, task snippets, queued-at times and a
  per-row **Stop** (queued cancel is immediate through the existing stop
  route), with a `+N more` tail, an aria-live summary and honest queue copy;
  mid-run steering is a separate explicit action (wave 23:
  `POST /api/runs/{run_id}/steer` plus the composer **Steer run**/`Alt+Enter`),
  never a queued task. The next queued run
  is adopted/followed on `run_end`, and an older backend with no active run
  records shows no dock. Files: `web/src/queueState.ts`,
  `web/src/components/QueueDock.vue`, `web/src/App.vue`,
  `web/src/components/Composer.vue`; tests `web/tests/queueState.test.ts`.
- **`allow_session` approval scope** — a third "Always allow this session"
  decision on the approval card (button; `a` on a focused card, `y`/`n`
  unchanged). The broker records the `(action, normalized target)` pair for the
  run, checks it before the denial cap and resolves ALLOW without parking,
  emitting one additive `approval_auto_allowed` event `{action, target}`
  instead of `approval_requested`; a stopped run still denies. The route takes
  `scope: "once" | "session"` (strict enum, 400 invalid or session+deny) and
  echoes `{approval_id, decision, scope}`. Grants persist in
  `sessions/settings.json` top-level
  `"approvals": {"<session file>": ["<pair key>", ...]}` (newest-last, cap 64
  per session, atomic write, corrupt/missing section reads as empty = fail
  closed, cleared on session delete; seeded into the broker at run submit and
  again at start so queued runs see them) — never in the session JSONL. A shell
  pair stores the full command string, the same trust domain as the runtime
  sidecar. An older backend falls back honestly to a one-shot allow with a
  notice; fail-closed defaults and the denial cap are unchanged. Files:
  `src/runevents.ts`, `src/settings_store.ts`, `src/server.ts`,
  `web/src/api.ts`, `web/src/components/ApprovalCard.vue`, `web/src/App.vue`;
  tests `tests/approvalbrokerdeny.test.ts`, `tests/settings.test.ts`,
  `tests/server.test.ts`, `web/tests/approvalSession.test.ts`.
- **Human CLI text layout (terminal polish slice 2)** — `run`/`chat` text mode
  prints blank-line-separated envelope blocks, a width-capped
  `── decision ──` rule, width-safe Markdown bodies (the TUI's
  `tui/markdownstyle.ts` renderer; model control/ANSI bytes sanitized first)
  and the compact footer `tokens N in / M out · cache n% · K calls · cost $…`
  when usage exists; generated help columns scale with the TTY width (non-TTY
  keeps 96 columns). `src/clilayout.ts` is the new pure layout module,
  `src/clistyle.ts` gained `paintEmphasis`. Machine modes
  (`--json`, `--json-events`, `--stream`, `--mode print`, `--dry-run`) stay
  byte-identical and the print-mode `tokens:`/`cost:` stderr lines are
  unchanged. Tests: `tests/clistyle.test.ts` (22),
  `tests/cli.test.ts` (20), the hermetic CLI E2E human anchors.
- **TUI polish deltas** — palette/help overlays paint their inner rows through
  the theme (headers, chords, descriptions, group labels, selected row;
  `plainTheme` byte-identical), the composer's duplicate MODE/SENIOR/JUNIOR meta
  row is gone (the status bar is the single source for mode and models), a
  transcript window that starts mid-block shows a dim `⋯` gutter marker, and
  the status-bar hint segment moved up in priority (activity → hints → context
  → tokens → cache → cost → elapsed → settings warning), so `Ctrl+T expand
  tool` and the default hints fit at ordinary widths (~120 columns). TUI suites:
  301 tests. Files under `src/tui/`; see `docs/cli-reference.md` and
  `docs/quickstart.md`.

## Shipped 2026-11-07 (TUI workspace + approvals, CLI live, web folding/seats/hero, plan function)

- **TUI workspace-bound runs, approval panel and `@file` mentions** —
  `tui --workspace <dir>` binds every turn to one confined root: the junior
  gets the `workspace_*` belt, the senior the read-only verify slice, plugins
  bind workspace-bound and the composer `@path` picker/attachments read from
  it. A parked write/edit/delete/shell replaces the composer with a docked
  approval panel (action/target/command/reason, bounded diff summary; numbered
  `1 Allow once` / `2 Always allow this session` / `3 Deny`, mnemonics
  `y`/`a`/`n`, Up/Down + Enter, `Esc` = deny once, `Ctrl+E` full-screen
  diff/command preview). The session allow is in-memory for that TUI process
  only — never persisted to settings; stopping/cancelling denies all pending
  requests (fail closed); the broker denial cap is unchanged. The additive
  `ApprovalRequestedEvent` carries optional `reason`/`detail`
  (`ApprovalDetail` diff/command preview). `@path` mentions attach workspace
  files under the server caps (5 files / 20 000 chars each / 100 000 total,
  text only); invalid roots exit 2 before the screen opens; `/permission` now
  states the real bound-workspace policy. Files: `src/tui/app.ts`,
  `src/tui/view/approval.ts` (new), `src/tui/view/screen.ts`,
  `src/tui/keymap.ts`, `src/tui/view/mentionpicker.ts`, `src/permissions.ts`,
  `src/runevents.ts`, `src/workspace.ts`, `src/cli.ts`, `src/clihelp.ts`;
  tests `tests/tuiworkspace.test.ts` (20). See `docs/keyboard.md` and
  `docs/cli-reference.md`.
- **Live TTY transcript for `run`/`chat`** — on an interactive stdout each
  envelope block streams as produced, with dim `· …` activity rows from
  `prompt_audit` and tool events; the decision rule and compact footer still
  print once. New `--live`/`--no-live` flags (`run`/`chat` only; `--no-live`
  wins, `--live` cannot force a pipe); piped human output and every machine
  mode stay byte-identical (asserted in the hermetic CLI E2E, including piped
  bytes under both flags). The per-envelope renderer moved to
  `src/clilayout.ts` so the finished and live projections cannot drift;
  `CliIO` gained an optional `isTTY`. Tests: `tests/cli.test.ts` (26),
  `tests/clistyle.test.ts` (27).
- **Web step folding, composer status seats and welcome hero** — completed-run
  tool/prompt-audit rows fold into one muted disclosure row
  (`… N tool calls · expand`, plus `in M runs` when a group spans several runs;
  a real button with `aria-expanded`; single rows stay open, conversation rows
  never fold, the followed run stays open, collapsed rows leave the DOM so
  find/copy match the render). The
  composer gained truthful status seats: models (hidden until settings load),
  the real permission expectation, and the latest prompt audit's exact
  system/context char counts + offered-tool count (never fabricated tokens;
  unknown seats are absent). Empty sessions and the no-session landing state
  show a welcome hero with workspace context, actions and starter suggestions
  that only prefill the editable composer. Files:
  `web/src/components/ChatView.vue`, `App.vue`, `Composer.vue`,
  `folding.ts` (new), `composerStatus.ts` (new),
  `components/WelcomeHero.vue` (new), `style.css`; tests
  `web/tests/folding.test.ts` (16), `web/tests/composerStatus.test.ts` (9).
- **Plan/todo function (`todo_write`)** — a built-in tool both brothers
  receive (no approval, never touches the workspace) that replaces the whole
  plan in one call (`{todos: [{content, status}]}`, tolerant sanitize, ≤50
  entries, last write wins), returns compact text and emits one additive
  `todo_updated` runtime event `{todos}` (persisted in the run sidecar,
  SSE + replay; no protocol envelope change), with `HarnessResult.todos`
  carrying the final snapshot. The TUI docks a compact plan panel above the
  composer (✓/▸/○, ≤4 rows + honest `+N more`, display-only, replayed from the
  sidecar on resume/switch when the session has one) and the web renders a
  Plan dock with the same bounded selection, an expand button and an aria-live
  announcement. Files: `src/todos.ts` (new),
  `src/harness.ts`, `src/runevents.ts`, `src/index.ts`,
  `src/tui/view/todo.ts` (new), `src/tui/app.ts`,
  `web/src/components/TodoPanel.vue` (new), `web/src/runtime.ts`,
  `web/src/types.ts`, `web/src/App.vue`; tests `tests/todos.test.ts` (17),
  `tests/tuitodo.test.ts` (12), `web/tests/todo.test.ts` (11). See
  `docs/cli-reference.md` → "Plan and todo function".

## Shipped 2026-11-07 (wave 3: TUI provider connect, footer tips, plan durability, browser E2E)

- **TUI provider connection (owner bug fix)** — the TUI used to build role
  providers from CLI flags/env only and silently ignored the provider
  configuration saved by the web Settings, `serve` or `onboard`
  (`<sessions-dir>/settings.json`). It now loads that store at startup and
  re-resolves before every turn/compaction through the same
  `SettingsStore`/`RuntimeSettings`/`resolveRoleEndpoints` stack `serve` uses,
  so persisted presets, manual fields and decrypted stored keys drive the turn
  harness, the `/compact` provider, model pickers, status bar and welcome.
  Precedence: explicit CLI flags/env pairs (role pair > shared pair,
  all-or-nothing; an explicit connection pair clears a named ref, and an
  explicit non-default `--provider` overrides the persisted role providers) >
  persisted role
  settings (manual fields, else a named `provider_ref` through the merged
  seed+stored preset table) > built-in seed presets > harness per-field
  fallback; env-pinned fields are never persisted and a dangling ref warns and
  falls back instead of crashing. New in-TUI `/provider` (also `/settings` →
  **Connect provider…**; `/settings` is in Ctrl+P) shows a key-free per-role
  summary then a preset-or-manual connect; saving is one atomic encrypted
  settings write, failures keep the dialog with the real error and change
  nothing, and a failed turn points at `/provider`/the endpoint flags while
  keeping the provider error. Keys are masked while typing and never appear in
  frames, transcripts, history or sidecars. Files: `src/tui/providers.ts`
  (new), `src/tui/view/provider.ts` (new), `src/tui/app.ts`,
  `src/tui/keymap.ts`; tests `tests/tuiproviders.test.ts` (23, registered in
  `tests/run-all.ts`).
- **TUI status-bar tip rotation + transient hint channel** — the status bar's
  hint slot now rotates one registry-derived, high-value tip per accepted turn
  (`Ctrl+T fold tool output`, `Ctrl+F find in transcript`, `Ctrl+P commands`,
  `? keys and help`, `Ctrl+R search prompt history`, `Ctrl+B status panel`, and
  `Esc stop the turn` while running), deterministic from an app turn counter
  (no clock/randomness), with unavailable commands skipped and the tool-fold
  action leading (and excluded from the rotation) whenever a tool row is on
  screen. A new transient slot outranks the rotation for a bounded render
  budget (6 renders): `turn stopped — Ctrl+C ×2 exits` after a stopped turn,
  and always `deny to continue — Ctrl+C stops the turn after it resolves` while
  a workspace approval is parked (the panel owns the decision keys, so Ctrl+C
  is inert until answered). The transient hint is clipped into the remaining
  cells instead of dropped and never displaces the activity segment; no
  binding changed. Files: `src/tui/keymap.ts` (`FOOTER_TIPS`, `footerTips`,
  `rotatingFooterTip`, `composeStatusHints`), `src/tui/view/statusbar.ts`
  (`transientHint`, `APPROVAL_PARKED_HINT`, clipped fitting),
  `src/tui/app.ts`; tests `tests/tuiviewlane.test.ts`,
  `tests/tuistyle.test.ts`, `tests/tuiintegration.test.ts`.
- **TUI plan durability** — a TUI turn now persists each plan change as one
  `todo_updated` event in the session's runtime sidecar
  `sessions/runtime/<session-file>.events.jsonl` (same store/directory/key
  convention as `serve`: session file name unchanged, extension included), via
  the new fail-soft `src/tui/todoPersist.ts`; restarting the TUI with the same
  `--session-file` replays the last snapshot (last write wins, a cleared plan
  stays cleared). Only plan snapshots are written — tool/approval/envelope
  events still are not — and an in-memory session has nothing durable to write
  to. Tests: `tests/tuitodo.test.ts` (round-trip through a real store,
  restart/last-wins/clear, one line per write and nothing else, torn-line
  tolerance, fail-soft store path, compact event shape).
- **Approval reasons and a web approval-detail preview** — shell and delete
  approvals carry fixed honest reasons (`SHELL_APPROVAL_REASON`,
  `DELETE_APPROVAL_REASON`); write/edit stay reason-free because their diff is
  the explanation. The web card shows the reason while pending and keeps it
  after Allow/Deny (a resolution reason such as `cancelled` wins), the TUI
  panel shows its reason row, and the pending card gained a
  collapsed-by-default **Preview the change** / **Preview the command** toggle
  (real button with `aria-expanded`/`aria-controls`, `+N -M` counts, a
  `clipped` badge at the 20 000-char cap, plain-text `<pre>` diff/command, no
  HTML); older backends degrade to the previous card. Additive `reason`/
  `detail` on the wire only — no protocol envelope change. Files:
  `src/workspace.ts`, `web/src/components/ApprovalCard.vue`,
  `web/src/runtime.ts`, `web/src/types.ts`; tests
  `web/tests/approvalSession.test.ts` (19), `tests/workspace.test.ts`,
  `tests/approvalbrokerdeny.test.ts`.
- **Browser E2E coverage for the new web UX** — the hermetic Playwright suite
  is now 13 offline scenarios plus the opt-in `real` skip (**13 PASS, 0 FAIL,
  1 SKIP**): `chat`, `resume`, `approval-allow`, `approval-deny`, `stop`,
  `mobile`, `appearance-density`, `provider-reset`, plus this round's
  `folding`, `plan-dock`, `composer-seats`, `hero-starters` and
  `approval-reason`. The scripted fixture server/README were extended so the
  new scenarios exercise real projection/annotation/approval-detail paths; the
  suite stays fully hermetic (temp dirs, free ports, system Edge headless, no
  network). Tests only.

## Shipped 2026-11-08 (wave 4: tools for both brothers, composer recall, approval modes, web tokens, follow-ups)

- **Tool calling for both brothers** — in consult mode the senior's opening,
  the junior's proposal/revision and the senior's review may now call the
  role's **read-only** tool belt before emitting the structured reply, reusing
  the bounded `toolLoop` (`MAX_CONSULT_TOOL_ITERATIONS` = 4). The consult belt
  is the role's belt minus `WORKSPACE_MUTATION_TOOL_NAMES`
  (`workspace_write_file`/`workspace_edit_file`/`workspace_delete_file`/
  `workspace_run_shell`) and the display-only plan tool, so a consult node can
  never mutate; `senior_decide` deliberately stays a plain call (the review
  immediately before it already ran the checks). A node only loops when its
  belt is non-empty AND the provider implements `chatWithTools` — tool-less
  configurations keep the exact pre-tools request path (no tools on the wire,
  no extra calls, same prompt-audit sections). Work mode is unchanged
  (delegation, junior mutating deliverable loop, senior approval-brokered
  verify slice and its `run_shell` carve-out). Files: `src/harness.ts`;
  tests `tests/toolcalling.test.ts` (10).
- **Up/Down previous-message recall in the TUI and web composers** — both
  composers walk accepted submissions newest first and preserve/restore the
  live draft byte-exactly; only submitted tasks are recallable and navigation
  never appends. TUI (persisted prompt history): single-line drafts recall
  immediately, multiline drafts only at their very edges, so interior caret
  movement never replaces text mid-draft. Web: new pure `web/src/recall.ts`
  (versioned bounded `localStorage` blob
  `two-brothers.composerHistory.v1`, newest first, 100 entries, consecutive
  dedupe, fail-soft) wired through `Composer.vue`/`composerKeys.ts`; recall is
  suppressed while a picker is open and a recalled entry never becomes a saved
  draft. Also: `/provider` is a native registry command now, so a discovered
  `provider.md` template cannot shadow the connect surface (native wins the
  name; the template is dropped from the catalog with a diagnostic). Files:
  `src/tui/editor.ts`, `src/tui/app.ts`, `src/tui/keymap.ts`,
  `web/src/recall.ts` (new), `web/src/components/Composer.vue`,
  `web/src/composerKeys.ts`; tests `tests/tuirecall.test.ts` (3),
  `web/tests/recall.test.ts` (7), extended `tuieditor`/`tuiintegration`.
- **Approval modes and guardrails** — four honest operator modes for workspace
  actions: `ask` (default: reads free, mutations/shell ask), `readonly` (only
  reads run; mutations and shell denied without asking), `edits` (reads/writes/
  edits free; deletes and shell ask) and `allow-all` (everything runs without
  asking; explicit opt-in with a visible warning). The policy is a fixed
  decision table in `PermissionPolicy`; persisted top-level in
  `sessions/settings.json` as `approval_policy` through the atomic, validated
  `SettingsStore.writeApprovalPolicy` (missing/corrupt/unknown reads as `ask`;
  other sections preserved); exposed additively on `GET/PUT /api/settings`
  (`{mode, pinned}`; strict enum → 400, failed write → 500) and applied to
  every new run. CLI: `--approval-mode` + `TWO_BROTHERS_APPROVAL_MODE` on
  `run`/`chat`/`serve`/`tui` (invalid = exit 2; `serve` pins its web runs,
  `tui` pins the process, both never persisted; `run`/`chat` inert without a
  workspace; `allow-all` warns visibly). The TUI's `/permission` dialog states
  the mode, its description and the allow-all warning, persists a chosen mode,
  states a flag/env pin honestly (only Close then) and accepts a typed
  `/permission <mode>`; every workspace turn reads the mode fresh. The web
  Settings gains **Approvals** with honest copy, inline danger warning and
  pinned/old-backend read-only states (an old backend omits the field; the
  client shows Ask and never sends a patch). Guardrails: a mode never bypasses
  workspace confinement/sensitive-path refusal (they run before permissions),
  `readonly` denies even with a broker, broker answers can only choose
  allow/ask/deny, broker-null stays fail-closed, session-allow pairs/denial
  cap/overlay-close semantics unchanged, and the model/tools can never set the
  mode. Files: `src/permissions.ts`, `src/config.ts`, `src/settings_store.ts`,
  `src/server.ts`, `src/cli.ts`, `src/clihelp.ts`, `src/index.ts`,
  `src/tui/app.ts`; web `src/approvalPolicy.ts`,
  `components/settings/ApprovalPolicySection.vue`, `SettingsDialog.vue`,
  `api.ts`, `types.ts`; tests `tests/approvalmodes.test.ts` (19),
  `tests/tuiapprovalmodes.test.ts` (6), extended
  `settings`/`server`/`approvalbrokerdeny`, `web/tests/approvalPolicy.test.ts`
  (12).
- **Wave-3 follow-ups** — (a) explicit `--provider` provenance: `Config`
  records whether the run-level provider came from the flag/env, so an
  explicit default-valued `--provider openai` now overrides a persisted
  non-default provider while an absent flag keeps persisted settings (flags >
  env; env pins never persisted); (b) the TUI provider connect view clips its
  box title to the real budget, so 20/25/29-column frames stay width-safe;
  (c) the browser E2E runner guards the packaged `packages/harness/web` copy
  against `web/dist` by path set + content and auto-resyncs a stale copy
  (`e2e/web-freshness.mjs`, 12 pure tests), failing actionably when the build
  is missing or the sync cannot converge; (d) `/provider` native shadowing
  fixed; (e) the `approval-reason` browser scenario now clicks the pending
  card's preview toggle through expand/collapse, asserting plain-text content
  (literal HTML stays escaped text, no handler runs), `aria-expanded`, and the
  resolved card dropping the pending-only preview. Tests:
  `tests/cliproviderprovenance.test.ts` (10), extended
  `tests/tuiproviders.test.ts` (26) and `tests/tuieditor`/`tuiintegration`,
  `e2e/web-freshness.test.mjs` (12), browser suite unchanged at 13 offline
  scenarios (+1 opt-in skip).
- **Web design-token layer** — the web chrome now reads one semantic
  custom-property layer, `web/src/tokens.css` (imported first by `main.ts`):
  93 tokens — 45 semantic colour tokens with full light/dark parity (surfaces,
  three text tiers, borders, intent accents with the role colours
  operator/senior/junior, diff add/remove, find hits, thinking, elevation) and
  48 scheme-independent tokens (radii, a rem spacing scale, type,
  duration/easing, focus-ring geometry, layout contract). The dark palette
  still ships twice (prefers-color-scheme + pinned `data-theme='dark'`) and a
  deterministic test pins the two declarations identical. `style.css` and the
  owned chrome components (Sidebar, SessionGroup, SessionRow, WelcomeHero)
  were migrated value-for-value (literal colours/radii/spacing/focus-ring →
  `var(--token)`), with zero visual difference; naming was translated from
  kimi-code's token layer (MIT reference — attribution row added). Files:
  `web/src/tokens.css` (new), `web/src/style.css`, `web/src/main.ts`, the four
  owned components; tests `web/tests/tokens.test.ts` (7).
- **Approval-mode-aware composer seat** (wave 4 follow-up) — the web composer's
  permission status seat now names the effective workspace approval mode
  (`Ask in app` / `Read only` / `Edits auto` / `Allow all`) from the additive
  `approval_policy` settings field, with a truthful tooltip per mode, and
  keeps the fail-closed `ask` copy for an older backend that omits the
  section. Files: `web/src/composerStatus.ts`,
  `web/src/components/Composer.vue`; tests
  `web/tests/composerStatus.test.ts`.

## Shipped 2026-11-08 (wave 5: browser recall coverage, diff tokens, load suite)

- **Browser coverage for web composer recall** — new hermetic `composer-recall`
  scenario (two accepted submissions, newest-first Up/Down recall in the real
  textarea, byte-exact draft restore, multiline edge rule, no accidental
  submit, reload persistence); the browser suite is now 14 offline scenarios
  plus the opt-in `real` skip. The web `/help` shortcut table also lists the
  Up/Down recall gesture (a discoverability gap the lane reported).
- **Diff views consume the design tokens** — `DiffView.vue`/`DiffReview.vue`
  switched from `--ok`/`--danger`/`color-mix` to the dedicated
  `--diff-add-*`/`--diff-del-*` tokens; the wave-4 diff token values were
  reconciled to the colours the views actually rendered (they had never been
  consumed), so the visual result is identical. The provider connect view's
  redundant caller-side title pre-clip was removed now that `renderBox` owns
  the title budget.
- **Hermetic load/scale suite** — new `tests/load.test.ts` (5 tests, about
  1 s): 1,500-envelope session resume, bounded 400-block transcript
  projection, 200-session listing, 8 concurrent `RunManager` runs behind a
  barrier, and repeated compaction keeping exactly one summary with a
  bounded, non-growing transcript. Deterministic and wall-clock-free
  (closes the hermetic part of the "no load tests" gap; real-network
  load/fault injection remains open).

## Shipped 2026-11-08 (wave 6: shell-approval caution, recall key fall-through)

- **Shell-approval caution after a denied mutation** — the `RunApprovalBroker`
  tracks whether the operator already denied a write/edit/delete in the run;
  a subsequently parked `workspace_run_shell` request's existing additive
  `reason` gains one bounded caution sentence ("a file change was denied
  earlier in this run — review this command closely") so the web card, TUI
  panel, approvals API and plugin/MCP consumers all show it. Display-only: no
  decision, pair key, denial-cap, session-allow or event-shape change; base
  reasons stay byte-identical when nothing was denied, and `readonly`
  (which denies shell) never parks. Tests: `tests/approvalshellcaution.test.ts`
  (15).
- **Web composer recall key fall-through** — when recall is inactive (nothing
  to recall at the caret), `↑`/`↓` are no longer consumed: the textarea keeps
  its native caret movement instead of a swallowed no-op. Active recall
  semantics are unchanged (newest-first Up, Down stepping and byte-exact draft
  restore, multiline absolute edges, IME/repeat/modifier/selection/picker
  guards), and the hermetic `composer-recall` browser scenario now asserts the
  native fall-through in the real UI. Docs state that recall history is global
  while unsaved drafts are per-session.

## Shipped 2026-11-08 (wave 7: persisted reasoning replay, token migration, fault injection)

- **Persisted reasoning replay (part 1)** — when token streaming is active the
  harness buffers the sanitized reasoning per provider call and emits one
  additive `{type: "reasoning", role, kind, text, truncated}` runtime event
  (bounded at 10,000 chars head+tail, ANSI/control stripped); `RunManager`
  persists it to the session runtime sidecar automatically (no protocol or
  session-JSONL change), and the web replays a collapsed-by-default
  **Thinking · replayed** row after a reload (tolerant of malformed/oversized/
  old-backend rows; TUI replay shipped in wave 8). Honest limitation:
  capture requires streaming (web always opts in; CLI/TUI need
  `--stream-tokens`) because the plain provider contract returns no reasoning
  text. Files: `src/harness.ts`, `src/runevents.ts`, `src/index.ts`; web
  `types.ts`, `runtime.ts`, `ChatView.vue`, `folding.ts`; tests
  `tests/thinkingpersist.test.ts` (7) + web timeline (+4).
- **Remaining web chrome sheets on the design tokens** — nine more component
  sheets (CommandPalette, ToolActivity, ApprovalCard, UsageFooter,
  ContextMeter, PromptAudit, CommandResult, SidebarFooter, WorkspaceFinder)
  migrated canonical radii and scale spacing to the existing token layer (45
  value-for-value replacements, token inventory still 93, zero visual delta);
  `web/tests/tokens.test.ts` now covers 14 migrated sheets and bans canonical
  radius/scale-spacing literals there.
- **Real-socket fault-injection E2E** — new opt-in
  `packages/harness/e2e/faults.ts` (`npm run test:e2e:faults`) drives the real
  retry/timeout/overflow machinery over actual loopback TCP through a
  scripted `node:http` server: seven deterministic scenarios (429+Retry-After,
  transient 5xx, per-attempt timeout, overflow fail-fast, genuine
  compact-and-retry recovery, bounded always-overflow, fatal quota), ~0.3 s,
  PASS/FAIL exit contract, evidence in the gitignored `e2e/runs/`. The full
  offline smoke gate now runs it; real external-network load/fault injection
  remains an open item.

## Shipped 2026-11-08 (wave 8: TUI reasoning replay, JSON env alignment, token completion)

- **TUI replay of persisted reasoning** — a session carrying persisted
  `reasoning` sidecar events now shows a bounded, dim
  `THINKING (replayed) · ROLE · kind` section in the TUI transcript on
  load/resume/session switch (sidecar order; ≤4 preview rows per record with
  `… +N lines` / `… clipped for length` markers, ≤24 records with older ones
  collapsed behind a count). Read-only, fail-soft on missing/torn/malformed
  rows, never writes reasoning events; live thinking unchanged; frames without
  replay payload are byte-identical. Files: `src/tui/reasoningPersist.ts`,
  `src/tui/view/reasoning.ts` (new), `app.ts`, `view/transcript.ts`,
  `view/screen.ts`; tests `tests/tuireasoningreplay.test.ts` (14).
- **`TWO_BROTHERS_JSON` aligned with `--json`** — the env var now selects the
  same single machine-readable output object as a bare `--json` (for `run`,
  `--dry-run` plans and each `chat` turn, with REPL decoration suppressed),
  instead of the retired legacy "decision JSON on the last line after the
  transcript". Precedence stays unchanged (`--stream`, `--json-events`,
  explicit `--mode` and explicit flags win); PROTOCOL.md §7's env row is
  updated with no envelope/schema change; the reference `typescript/` tree got
  the same 6-line fix (it had the identical flag-default shadowing bug).
  Migration note documented (parse the new object's `decision` key, or use
  `--mode print` / `--mode print --json`). Tests: `printmode` (+5), `cli`
  (+1 spawned parity).
- **Final web chrome sheets on the design tokens** — `App.vue`,
  `ChatView.vue`, `Composer.vue` migrated their canonical radii/scale spacing
  to the token layer (32 value-for-value replacements, token inventory still
  93, zero visual delta); `web/tests/tokens.test.ts` now guards 17 migrated
  sheets. The design-token migration is complete; only documented one-off
  values stay literal.

## Shipped 2026-11-08 (wave 9: drag-and-drop reordering, vue-tsc 3.3)

- **Drag-and-drop workspace reordering (web)** — each sidebar workspace group
  has a dedicated pointer-only grip handle; dropping it on another header
  shows an honest insert indicator and reorders optimistically through the
  existing `PUT /api/workspaces/order` path (revert-with-toast on failure).
  The whole header is not a drag source, the handle is out of the tab order
  with an `aria-describedby` instruction, dragging is disabled while
  filtering, touch devices use the menu, and the group `⋯` menu
  Move up/Move down remains the keyboard path. Pure helpers
  `dropReorderDelta`/`dropReorderIds` in `web/src/workspaceOrder.ts` (clamped,
  no-op-aware); `web/tests/workspaceOrder.test.ts` 21 tests (+6); new
  hermetic browser scenario `workspace-drag` (sidebar order + persisted API
  order + click/expand/fallback assertions) — the browser suite is now
  15 offline scenarios + the opt-in `real` skip.
- **`vue-tsc` 3.3 bump** — the web devDependency moves from the 2026-11-04
  advisory pin `~3.0.2` (resolved 3.0.11) to `~3.3.0` (resolved 3.3.14):
  zero template-scope diagnostics in a forced `vue-tsc -b` across all 38
  SFCs, web suite 329/329, `npm run build` green, and only the web-local
  `web/package-lock.json` subtree changed (the web app is not an npm
  workspace). Closes the follow-up; future web dependency bumps must run npm
  inside `web/`.

## Shipped 2026-11-08 (wave 10: Anthropic extended thinking, reasoning-replay browser coverage)

- **Anthropic extended thinking (reasoning passback part 2)** —
  `--thinking-budget <n>` / `TWO_BROTHERS_THINKING_BUDGET` (pinned, never
  persisted; min 1024; other providers ignore it) makes Anthropic Messages
  roles request `thinking: {type:"enabled", budget_tokens:n}` (plain,
  streaming, tool loops); `temperature` is omitted while enabled and a cap
  that does not exceed the budget is raised to budget + 1024 with one honest
  warning. Signed thinking blocks (streamed `thinking_delta`/`signature_delta`
  or non-streamed; `redacted_thinking` payloads included) are captured and
  echoed verbatim as the first blocks of tool-loop assistant turns, so
  Anthropic accepts multi-round tool loops; they never enter the protocol
  transcript, session JSONL or other adapters, and unset keeps requests
  byte-identical. Tests: `tests/thinkingpassback.test.ts` (13).
- **Browser coverage for persisted reasoning replay** — new hermetic
  `reasoning-replay` scenario: the e2e scripted fixture streams real
  `delta.reasoning_content` chunks, the run sidecar must hold four bounded
  `reasoning` runtime events (while a plain session holds none), and after a
  page reload the collapsed `Thinking · replayed` rows expand to sanitized
  plain text (injected HTML-looking payload stays escaped text, no handler
  runs), the over-long record is head+tail bounded with the clipping marker,
  and the plain session shows no replay rows. The browser suite is now
  16 offline scenarios + the opt-in `real` skip. Files: `e2e/run.mjs`,
  `e2e/fixtures/scripted-server.mjs` (+ README).

## Shipped 2026-11-08 (wave 11: CI hardening, thinking coverage, real-network load runner)

- **CI workflow brought in line with the hermetic gates** — `.github/workflows/ci.yml`
  now runs the real-socket fault-injection runner (`node e2e/faults.ts`) and
  the packaged-web freshness unit tests (`node --test e2e/web-freshness.test.mjs`)
  on both Node 22/24 matrix legs (validated locally on both versions; browser
  E2E and live/real-network layers remain opt-in/manual), so a future push
  exercises the wave-5/7 additions.
- **Anthropic thinking coverage polish** — `tests/thinkingpassback.test.ts`
  13 → 17 tests: a streamed `redacted_thinking` block is asserted to be
  echoed verbatim (opaque payload byte-identical) as the first content block
  of the next tool-loop request without leaking into envelopes, and mixed
  per-role wire kinds (senior-Anthropic/junior-OpenAI and the inverse) prove
  the run-level budget reaches both role providers while only the Anthropic
  role's request body carries `thinking` (the other role's raw request bytes
  are identical to the no-budget control).
- **Opt-in real-network load runner** — new `packages/harness/e2e/load.ts`
  (`npm run test:e2e:load`): bounded-concurrency pool of real CLI runs against
  an operator-provided OpenAI-compatible endpoint, per-run PASS/FAIL + wall
  times, honest summary (observed concurrency, failures/exit codes, latency
  min/median/max), exit 0/1/2, child cleanup, never in `npm test`/smoke/CI.
  Recorded against the owner's LM Studio `lfm3-1.7b` (2026-11-08, concurrency
  2 / runs 3): 3/3 PASS, 78.7–93.7 s per run, 157.6 s wall. The hermetic fault
  counterpart remains `e2e/faults.ts`; a `serve` RunManager/worker-pool soak
  is deliberately manual-only.

## Shipped 2026-11-08 (wave 12: serve-level load/soak tooling, naive-ui guard investigation)

- **Opt-in serve-level load/soak runner** — new
  `packages/harness/e2e/serve-load.ts` (`npm run test:e2e:serve-load`): starts
  the real `serve` backend (hermetic `--mock` self-test or real
  `--base-url`/`--model` with env fallbacks), registers a temp workspace,
  creates one session per run (the protocol serializes same-session runs, so
  `--workers > 1` only helps across sessions), submits bounded-concurrency
  runs and polls `GET /api/runs`, cross-checking transitions against the
  persisted runtime sidecars. Per-run PASS/FAIL with `queued → running →
  completed` + queue/run/submit timings, honest summary (observed in-flight
  max, peak queued/running, persisted-sequence count, terminal states,
  latency min/median/max, total wall), exit 0/1/2, child/temp cleanup and
  signal handling; needs a build + endpoint (unless `--mock`) and is never in
  `npm test`/smoke/CI. Recorded evidence (2026-11-08): mock `--runs 3
  --workers 1` → 3/3 completed (0.3–2.8 s depending on machine load; the persisted sidecar sequence is the queueing evidence, not submit latency); owner LM Studio
  `lfm3-1.7b`, `--runs 2 --workers 1` → 2/2 in 230.8 s (run 2 queued 117.7 s
  behind run 1; 7 vs 8 model calls), peak queued/running 1. Long soaks remain
  an operator choice.
- **Stacked-dialog guard investigation (no change)** — version-bounded
  evidence: `naive-ui` 2.45.3 is the latest published release (2026-08-27)
  and its modal implementation still fires `mask-click` for clicks inside a
  stacked second dialog (unconditional capture-phase `clickoutside` in
  `BodyWrapper`; `Modal.handleClickoutside` calls `onMaskClick` for every
  outside click; the `evtd` trap only checks the first dialog's own body),
  while the 2.45.2 fix explicitly reverted the earlier mask-level click
  design. The `web/src/modal.ts` guard therefore stays; re-check after a
  naive-ui release > 2.45.3 that makes mask clicks attributable/stacking
  aware.

## Shipped 2026-11-08 (wave 13: accent themes, Windows CI leg, docs↔CLI drift guard)

- **Operator-selectable web accent themes** — Settings → Appearance gains an
  accessible native radio group for the accent: **Blue (default)**, Violet,
  Teal, Amber. The variants are token-layer scoped overrides
  (`:root[data-accent=…]` plus matching media/pinned dark blocks) of exactly
  eight accent/focus/selected tokens, including a new `--accent-text` (the
  now-94-token inventory, light/dark parity, per-variant completeness and the
  untouched role identity colours are test-enforced). Accent-coloured text
  uses `--accent-text`: in the light scheme it equals the accent (no visual
  change), while the dark schemes and variants use lightened values (blue
  `#6c9bff`, violet `#a78bfa`, teal `#5eead4`, amber `#fbbf24`) verified to
  clear WCAG AA 4.5:1 against the dark surfaces by the token test; fills,
  borders and focus rings stay on `--accent`. The choice persists in the
  versioned `two-brothers.ui-prefs.v1` blob (unknown → Blue) and applies
  immediately as `data-accent`; new hermetic browser scenario
  `appearance-accent` covers keyboard-only selection, computed
  `--accent`/`--accent-text` in light/dark (including the dark contrast),
  reload persistence and restoring Blue (browser suite 17 offline scenarios,
  web suite 336 tests). The original limitation — native naive-ui primary
  controls keeping the brand blue because of naive-ui's static theme
  overrides — is closed in wave 14 (see the wave-14 shipped section).
- **Windows CI leg** — `.github/workflows/ci.yml` now runs the hermetic gates
  on a `windows-latest` Node 24 job as well as the ubuntu Node 22/24 matrix:
  reference selftest/tests, package typecheck/build/tests/dist selftest/mock,
  CLI E2E sources + dist, fault injection, web install/tests/build and the
  packaged-web freshness tests, with Git Bash prepended to `PATH` for the
  shell-spawning suites. The Node-22-only release rehearsal stays on ubuntu;
  browser E2E and live/real-network layers remain opt-in/manual. Locally
  validated step by step on Windows (15/15 commands green).
- **Docs↔CLI drift guard** — new `packages/harness/tests/clidocs.test.ts`
  (6 tests, part of `npm test`) keeps `docs/cli-reference.md` in sync with
  the code-owned CLI catalogue: two-way env-var coverage against
  `clihelp.ts::ENVIRONMENT`, env→flag mapping, two-way long-flag coverage for
  the run/chat/tui/serve accepted flags, and a tolerant command-heading
  check, with sorted set-diff failures and a skip when the reference file is
  absent (bare npm tarball). Proven to bite by temporarily introducing a
  divergent row and observing the exact failure before reverting.

## Shipped 2026-11-08 (wave 14: native accent controls, per-command docs guard)

- **Native naive-ui controls follow the accent theme** — closes the wave-13
  limitation. `web/src/theme.ts` carries a pure
  `accentThemeOverrides(accent, scheme)` mapping plus the canonical
  `ACCENT_NAIVE_PALETTES` table for blue/violet/teal/amber in light and dark
  (naive-ui primaryColor/hover/pressed/suppl = the same hexes as the CSS
  `--accent*` tokens); `App.vue` merges it into `NConfigProvider` reactively so
  native primary controls follow the operator accent immediately on an accent
  or theme switch (no reload). A drift test parses `tokens.css` and fails if
  the JS mapping and the tokens diverge (tokens suite 13 tests); the
  `appearance-accent` browser scenario asserts the native Settings primary
  button's computed background through Blue → Violet (light) → Violet (dark) →
  Blue. Non-primary intents stay static by design.
- **Per-command docs↔CLI flag audit** — `tests/clidocs.test.ts` (6 → 8 tests)
  now audits command-scoped flag tables: a `Flag` table under a command
  heading may document only flags that command accepts, and every
  run/chat/tui/serve accepted flag must be documented in the command's table
  or the shared `## Flags` pool; failures are per-command sorted diffs
  (`serve: documented-but-not-accepted: …; accepted-but-undocumented: …`).
  Fence-aware parsing; the header states the intentional non-coverage
  (prose/code-example flags, shared-table scope notes, `--help`, runtime-only
  env rows). Proven to bite by mis-scoping a documented flag and reverting
  byte-identically.

## Shipped 2026-11-08 (wave 15: test-enforced AA floors for accent text)

- **Accessibility floors closed** — value-only changes plus test-enforced WCAG
  AA: accent-coloured text now clears 4.5:1 on every surface it is actually
  used on in both schemes (panel/canvas, hovered and selected rows, soft accent
  chips; light soft/selected tints lightened imperceptibly — blue 4.42→4.58,
  amber 4.49→4.57, highlight 4.497→4.59; violet/teal and light hover surfaces
  already passed), and white text on native naive-ui primary/hover/pressed
  clears AA for all four accents in both schemes. To get there the dark accent
  hover deepens instead of lightening for blue/violet/teal (white 3.80→5.61,
  4.23→6.38, 4.02→5.22; amber keeps its lighter hover, already 5.02), with CSS
  `--accent-hover` and the naive palette changed in tandem so the drift test
  stays green; hover/pressed stay visibly distinct from primary. The token
  suite (14 tests) documents the accent-text surfaces, computes the floors with
  exact failure messages, and was proven to bite by temporarily reverting each
  value (byte-identical revert). Token inventory unchanged at 94; web suite
  338.

## Shipped 2026-11-08 (wave 16: configurable web key bindings, first slice)

- **Configurable web key bindings (three global chords)** — Settings → Keyboard
  rebinds the command palette (default Ctrl/⌘+K), find in the conversation
  (default Ctrl/⌘+F) and the shortcut reference (default Ctrl/⌘+/, `?` stays a
  fixed alias), persisted per device in a versioned bounded fail-soft store
  (`two-brothers.keybindings.v1`). A pure module owns the binding model (one
  platform Mod; Ctrl and ⌘ match each other so one binding travels), strict
  validation (Mod + one printable key; duplicate/Alt/plain/browser-reserved
  chords refused inline), event parsing/matching and platform-aware labels.
  One reactive keybindings ref drives App/ChatView/Settings/`/help` (dynamic
  current chords, rebindable badges, fixed-keys note; existing guards kept).
  The capture UI uses native buttons, `role=status` announcements, inline
  `role=alert` conflicts, per-row/global reset, and Escape cancels capture
  without closing Settings. Tests: `web/tests/keybindings.test.ts` (13) and
  the hermetic browser scenario `keybindings` (offline suite 18). All other
  shortcuts stay fixed in this slice.

## Shipped 2026-11-08 (wave 19: file-configured TUI key rebinding, global slice)

- **TUI rebinding for the three global chords** — `tui --keys-file <path>` /
  `TWO_BROTHERS_TUI_KEYS_FILE` (pinned, never persisted; default
  `~/.two-brothers/tui-keys.json`, missing = defaults) reads a versioned JSON
  document (`{"version":1,"bindings":{…}}`) that rebinds only the command
  palette (`palette`), shortcut reference (`help`) and draft stash (`stash`).
  `src/tui/keyoverrides.ts` parses the chord grammar
  (`[ctrl+][shift+][alt+]key`, one named terminal key or one printable
  character), validates against the allowlist and the fixed registry
  (unmodified letters/digits, structural keys, `Ctrl+C/Z/Q/S`, duplicates and
  fixed-chord collisions refused), bounds the file (16 KiB) and resolves a
  fresh command table; every read/parse/validation problem prints one
  `[tui keys]` stderr diagnostic and keeps the defaults (the TUI starts).
  `TuiAppOptions.commands` threads the resolved table through matching,
  palette/help listings and handlers, status hints, composer/welcome/status
  bar, find bar, mention picker, approval panel, provider connect, history
  search, side panel, input guard, slash resolution and `tui --help`; lane
  hint builders gained optional `commands` parameters (defaults keep the
  previous frames byte-identical). CLI/`clihelp.ts` catalogue the flag/env so
  the docs↔CLI drift guard stays green. Tests: `tests/tuikeys.test.ts` (25) +
  2 injected-override `tests/tuiintegration.test.ts` cases. Remaining
  surfaces stay fixed by design: typing/composer keys, Escape/quit layering,
  picker/overlay navigation, approval keys, the find bar, an in-TUI editor
  and hot reload.

## Shipped 2026-11-08 (wave 21: role-colour palettes, web theming gap closed)

- **Operator-selectable role-colour palettes (web)** — Settings → Appearance's
  native **Role colours** radio group offers Default (the historic
  blue/teal/grey identity colours, unchanged look), High contrast and Neutral
  (muted labels-only), for the Senior/Junior/Operator colours independent of
  the accent theme. Persisted additively in the versioned `uiPrefs` blob and
  applied as `data-roles`; the token blocks override only
  `--senior`/`--junior`/`--operator` in light + both dark blocks (inventory
  stays 94). Contrast palettes: light senior/junior/operator
  `#2456d2/#0f6d5a/#545c6a`, dark `#7d9fdd/#46baa0/#a3abba` (worst computed
  role-text AA 5.45/5.41/5.83 light and 5.36/5.98/6.19 dark over the
  documented host surfaces); neutral palettes are muted AA greys. Tests:
  token-suite role-palette parity + computed AA floors (15 tests), uiPrefs
  9→13; new hermetic `appearance-roles` browser scenario (offline suite 19).
  The historic Default palette is unchanged (not AA on every documented
  surface in either scheme, worst in dark — the documented reason for the
  alternatives); role avatar/dot fills stay decorative (in the dark accessible
  palettes the aria-hidden initials sit white-on-light while the labels carry
  identity), with a fill/text token split recorded as an optional follow-up.

## Shipped 2026-11-08 (wave 22: TUI `/keys` show + live reload)

- **TUI `/keys` built-in** — a chordless `keys` command (Settings group,
  `/keys [show|reload]`) now exposes the file-configured global chords inside
  the TUI: `/keys show` reports the effective palette/help/stash chords plus
  the captured keys-file path, origin (flag/env/default), honest load state
  and one bounded last-diagnostic line (never claiming overrides that are not
  active); `/keys reload` re-reads the startup-captured path (env/flag changes
  need a restart), validates with the existing fail-soft resolver and
  live-swaps the active command table so matching, palette/help listings and
  hints use the new chords immediately. Failures keep the **last good table**
  and post one bounded diagnostic; absent files keep the current chords with
  an informational notice, and a file absent at startup loads on a later
  reload. Files: `src/tui/keyoverrides.ts` (additive reload/describe helpers),
  `src/tui/app.ts`, `src/tui/keymap.ts`, `src/cli.ts` (origin/state capture);
  tests `tests/tuikeys.test.ts` (+3) and `tests/tuiintegration.test.ts` (+1);
  all 21 `tui*.test.ts` suites stay green with no changed listing/frame
  assertions. Remaining: in-TUI editor, file watcher/auto-reload, rebinding
  beyond the three global chords.

## Shipped 2026-11-08 (wave 23: web role fill tokens, TUI keys auto-reload)

- **Role fill/text token split (web)** — closes the open item of the same
  name. Three decorative fill companions join the token layer —
  `--senior-fill`/`--junior-fill`/`--operator-fill` (inventory 94 → 97) — in
  every palette block with light/dark parity. The role tokens keep their text
  meaning (identity labels, markers; the confidence bar keeps `--junior`);
  avatars, role dots and `.dot-*` backgrounds paint the fills. The default
  palette's fills equal its role tokens (byte-identical default look); the
  accessible contrast/neutral palettes get dedicated fills (dark contrast
  `#3b64c9`/`#1a7a66`/`#666e7c`, dark neutral
  `#575e6a`/`#616874`/`#6b727e`) so white initials/glyphs on every fill clear
  WCAG AA 4.5:1 in both schemes. Files: `web/src/tokens.css`,
  `web/src/style.css`, `web/src/components/settings/RoleEditor.vue`; tests
  `web/tests/tokens.test.ts` (16: fill set/parity, default equality, computed
  white-on-fill AA floors with pair+ratio messages, distinctness) and the
  hermetic `appearance-roles` browser scenario now asserts the rendered dots
  follow the fills in light and dark. Web suite 356/356, build green.
- **TUI keys-file auto-reload (opt-in)** — `tui --keys-watch` /
  `TWO_BROTHERS_TUI_KEYS_WATCH=1` (pinned, startup-captured, never persisted,
  off by default) polls the captured keys file with `fs.watchFile` (500 ms
  interval, 200 ms debounce/coalesce) and applies each detected change through
  the same validated `reloadTuiCommands` path as `/keys reload`: a valid edit
  live-swaps the command table (matching, palette/help listings, status hints)
  with one bounded notice naming the new chords; an invalid/unreadable file
  keeps the last good table with one bounded warning per detected change
  (no repeat spam while unchanged); absence keeps the current chords with an
  informational notice, and a later-created file loads on the next change.
  `/keys show` reports the honest watch state (`on`/`off`/`unavailable`) and
  the watcher is stopped/unwatched on every exit path; without the flag/env
  the default startup frames are byte-identical. Files: `src/tui/app.ts`,
  `src/tui/keyoverrides.ts`, `src/cli.ts`, `src/clihelp.ts`; tests
  `tests/tuikeys.test.ts` (40: catalogue/env, the full 6/6 load-state matrix,
  watch state, defaults, valid/invalid/absent/stop/debounce/uninstallable) and
  `tests/tuiintegration.test.ts` (25: assembled-app last-good auto-reload,
  embedded `unavailable`). Package suite 1 572 tests (1 570 pass, 2
  environment skips); typecheck green. Remaining: an in-TUI key-binding
  editor.

## Shipped 2026-11-08 (wave 23: steering, session lineage/rewind, file undo, prompt caching)

- **Mid-run operator steering** — the operator can steer a working
  cooperation cycle instead of only queueing the next task. A steer rides the
  shared context as an ordinary `message` envelope from `user` to `senior`
  (payload `{text}` prefixed with the documented `[[OPERATOR STEER]] `
  marker, dense `seq`, session JSONL included), so no protocol kind/field or
  session-format change exists; the harness drains a bounded in-memory queue
  (8 pending texts of at most 4 000 characters) at every state-machine node
  boundary (after `maybeCompact`) and tool-loop iteration, re-rendering the
  opening transcript inside a tool loop so the in-flight wire conversation
  stays legal for Anthropic/Google. At most 16 steer envelopes apply per run;
  an additive `steering_dropped` runtime event plus the run record's
  `steering_dropped`/`steering_pending` fields keep a cap drop honest, a
  broken drain callback is fail-soft, and nothing is appended after a stop.
  `POST /api/runs/{run_id}/steer` accepts a text only for `running` or
  approval-parked (`waiting`) runs; the web composer exposes **Steer run** /
  `Alt+Enter` and clears the draft only on a 200. Files: `src/harness.ts`,
  `src/runtime.ts`, `src/server.ts`, `src/runevents.ts`, `src/index.ts`,
  `web/src/steering.ts`, `web/src/api.ts`, `web/src/types.ts`,
  `web/src/App.vue`, `web/src/components/Composer.vue`,
  `web/src/shortcuts.ts`; tests `tests/steering.test.ts` (20) and
  `web/tests/steering.test.ts` (6). TUI steering shipped in wave 25
  (`Ctrl+N`); remaining: a browser E2E scenario for steering and real-provider
  validation (wave 26 added the tab-title and auto-compaction scenarios only).
- **Session fork + self-contained HTML export** — `POST
  /api/sessions/{name}/fork` and `sessions fork <name> [--at <seq>] [--name
  <new>]` copy a session prefix byte-for-byte into a NEW session file (dense
  `seq` preserved, source untouched), title `<source> (fork)`, local-only
  `parent: {name, seq}` sidecar link, and typed 400/404/409/422/500 errors; a
  fork does not inherit `workspace_id` or copy the runtime-event sidecar.
  `GET /api/sessions/{name}/export?format=html` and `sessions export <name>
  --format html` render one self-contained page (inline CSS, escaped
  payloads, no scripts/links/external URLs; 20 000-char per-payload and
  2 000 000-char document caps with an explicit truncation note), while
  markdown/json output stays byte-identical. Files: `src/sessionfork.ts`,
  `src/sessionsearch.ts`, `src/metadata.ts`, `src/server.ts`, `src/cli.ts`,
  `src/clihelp.ts`; tests `tests/sessionfork.test.ts` (20) plus the HTML
  export cases in `tests/sessionsearch.test.ts` (35); the web session row menu
  ships `Fork session…` and `Export as HTML`
  (forking is unavailable while a run is active). Wave 26 added the transcript's
  **Fork from here…** (`{seq}`) action; remaining: TUI fork surfaces.
- **Session rewind** — `POST /api/sessions/{name}/rewind` (`{turns}` 1–100)
  and `sessions rewind <name> --turns <n>` drop the last N operator turns, so
  a better task can be retyped without a growing context or a new session.
  The kept prefix is rewritten atomically with dense `seq` intact; harness
  context (compaction summaries, repair requests, operator steers, skill/file
  attachment blocks) is never counted as a turn; a compaction summary is a
  hard floor with an honest `stopped_at_compaction`/`stops_before`/`reason`
  clamp; nothing-to-cut is a 200 with `rewritten: false`. The route refuses a
  live run or manual compaction (409) and takes a read CAS against concurrent
  writers; a successful rewrite also clears the session's runtime-event
  sidecar (`sessions/runtime/<name>.jsonl.events.jsonl`) — tool/approval
  history for the removed runs is gone, the kept transcript remains, and the
  response reports `runtime_events_cleared`. Files: `src/sessionrewind.ts`,
  `src/server.ts`, `src/cli.ts`, `src/clihelp.ts`; tests
  `tests/sessionrewind.test.ts` (19). The web transcript offers **Rewind** on
  operator messages (destructive confirmation; blocked while a run is
  active/compacting, and at a compaction floor). Remaining: a TUI rewind
  surface.
- **Run-scoped workspace edit undo** — after a workspace-bound `serve` run,
  the operator can revert exactly the files that run mutated through
  `workspace_write_file`/`workspace_edit_file`/`workspace_delete_file` (shell
  commands, external edits and untracked files are never touched). The run
  captures bounded content-addressed pre/post images under `<sessions>/undo`
  (a restart-resilient session side artifact, never protocol JSONL; one entry
  per file = the net effect; capture is fail-soft and closes in the run's
  `finally`). `GET /api/sessions/{name}/undo/{run_id}` previews every recorded
  file against the live workspace (`applicable`/`created`/`deleted`/
  `changed-since`/`skipped`/`missing` + counts), `POST` applies the reversible
  entries (each file re-classified immediately before it is touched, so a file
  changed since the run is refused, never overwritten) and reports
  `applied`/`refused`/`failed`, and `DELETE` discards the record. Errors: 404
  unknown session/record, 409 a still-active in-memory run or an unusable
  record (corrupt/oversized/unsupported version/its workspace no longer
  registered), 422 store IO. The web workspace shows **Undo file changes…**
  for the newest completed run of the selected session (hidden with an honest
  notice on 404, unavailable while a run is live or a compaction is in
  flight) with a per-file preview/apply dialog. Files:
  `src/workspacehistory.ts`, `src/workspace.ts` (capture seam),
  `src/server.ts`, `src/index.ts`, `web/src/runUndo.ts`,
  `web/src/components/RunUndoDialog.vue`, `web/src/api.ts`, `web/src/App.vue`,
  `web/src/types.ts`; tests `tests/workspaceundo.test.ts` (28),
  `tests/serverundo.test.ts` (8), `web/tests/runUndo.test.ts` (12).
  **Closed in wave 26 (2026-11-08):** bounded retention plus orphan-blob GC,
  POSIX mode restoration (best-effort ownership), and a CLI `sessions undo`
  preview/apply/discard surface. A TUI undo surface is still absent because TUI
  runs do not capture.
- **Anthropic prompt caching + honest cache accounting** — every Anthropic
  Messages request carries up to three `cache_control:{type:"ephemeral"}`
  breakpoints (merged system prompt, last tool definition, newest conversation
  turn), so the repeated prefix of a cooperation cycle is read from the
  5-minute prompt cache on the 2nd..Nth call; multi-call runs save latency and
  input cost, a single-call run pays the write premium, and prompts below the
  model's cache minimum ignore the markers. No flag/setting; OpenAI-compatible
  and Gemini bodies are byte-identical. `cache_read_input_tokens` →
  `cached_tokens` makes the existing `cache N%` footer meaningful (writes are
  not hits; absent reports stay 0). Files: `src/provider.ts`; tests
  `tests/anthropiccache.test.ts` (9) with the intentional wire change pinned
  in `tests/adapters.test.ts`/`tests/thinkingpassback.test.ts`. Remaining:
  real-model cache-hit evidence, `ttl`/opt-out, cost-table cached-input
  discount.

## Shipped 2026-11-08 (wave 25: crash-torn resume, TUI steering, persisted compaction, signals, tab title)

- **Crash-torn session resume (F3)** — `SessionStore.load` ignores only a
  malformed **final** JSONL fragment in memory and reports it once;
  `--resume` repairs the file atomically (temp file + rename, or truncation to
  the last complete line) before appending, keeping dense `seq`. Interior
  corruption remains a typed `SessionError`, destructive rewind keeps the
  strict reader, and `sessions`, `show`, `search`, export and the server's read
  routes never rewrite. The search document carries additive
  `recovered`/`dropped_bytes`; CLI/TUI resume prints one bounded warning. Files:
  `src/session.ts`, `src/sessionsearch.ts`, `src/server.ts`; tests
  `tests/session.test.ts` (12), `tests/sessionsearch.test.ts` (36) and
  `tests/sessionapi.test.ts` (10). See `docs/cli-reference.md` → “Sessions”.
- **TUI steering** — `Ctrl+N` (also the `Ctrl+P` palette's **Steer the running
  turn** row) queues composer text for the running turn at its next step; at
  most 4 000 characters and 8 pending texts; blank/oversized/full-queue inputs
  are refused, the draft clears only on acceptance, and the copy distinguishes
  a queued steer from still-pending leftovers (an applied steer appears in the
  transcript). `Enter` while a turn runs keeps its
  refusal and names the chord. Files: `src/tui/steering.ts` (new),
  `src/tui/app.ts`, `src/tui/keymap.ts`; tests `tests/tuisteering.test.ts` (8),
  `tests/tuikeymap.test.ts` (19) and `tests/tuiintegration.test.ts` (27). See
  `docs/keyboard.md` → “Steering a running turn”.
- **Persisted compaction settings** — the top-level `compaction` section of
  `sessions/settings.json` (`threshold_chars`, `threshold_tokens`,
  `keep_recent_chars`, `context_window`) is served additively by
  `GET /api/settings` and accepted by `PUT`; the web Settings → Advanced
  **Auto-compaction** card edits it. Precedence: `ServerOptions.compaction` >
  explicitly-set non-zero CLI/env field > persisted > absent; `0` = off/unknown.
  Files: `src/settings_store.ts`, `src/server.ts`, `src/config.ts`,
  `src/index.ts`, `web/src/compactionSettings.ts` (new), the Advanced card;
  tests `tests/settings.test.ts` (42), `tests/serverbase.test.ts` (15) and
  `web/tests/compactionSettings.test.ts` (12). See `docs/cli-reference.md` →
  `serve` and `GET/PUT /api/settings`.
- **Cooperative CLI cancellation** — `SIGINT`/`SIGTERM` during `run`/`chat`
  abort the turn, wait a bounded cleanup, then exit (`SIGINT` = 130,
  `SIGTERM` = 143, POSIX `SIGHUP` = 129); a second signal force-exits.
  `serve` joins shutdown on `SIGHUP` too (idempotent; no second-signal force
  path). Machine stdout stays clean and an idle `chat` Ctrl+C is unchanged.
  Files: `src/turnsignal.ts` (new), `src/cli.ts`, `src/shell.ts`; tests
  `tests/cliwiring.test.ts` (+8) and `tests/serveshutdown.test.ts`. See
  `docs/cli-reference.md` → “Signals”.
- **Web tab title** — `▶` running/queued, `!` waiting, `… (failed)`, `(N)`
  unread without a selection, plain `Two Brothers` default; sanitized and
  capped at 120 characters. Files: `web/src/tabTitle.ts` (new),
  `web/src/App.vue`; tests `web/tests/tabTitle.test.ts` (16). See
  `docs/quickstart.md` → step 4.

## Shipped 2026-11-08 (wave 26: browser coverage, TUI clipboard/attention/editor, undo lifecycle, fork-from-here, hardening, doctor MCP, preset windows)

- **Browser E2E for the wave-25 web surfaces** — two hermetic scenarios close
  the coverage gap without a product-source change: `tab-title` (running
  `▶`, real-approval `!`, plain after completion, and the unread/selection
  rules; the full matrix including queued/`(failed)` stays unit-covered) and
  `settings-advanced` (the Auto-compaction card's four inputs, effective/source
  lines, inline validation blocking Save, one PUT, persistence and reload).
  Files: `e2e/run.mjs`, `e2e/fixtures/scripted-server.mjs` (and README). See
  `docs/testing.md`.
- **TUI clipboard and terminal attention** — `Ctrl+X` copies the newest
  committed decision (or newest completed senior reply) as plain text, native
  clipboard first with an OSC 52 fallback and an honest route-specific notice.
  The OSC 0 title carries `Two Brothers — <session> · working|approval|done|failed`,
  is restored on every exit path, and a parked approval emits one OSC 9/BEL
  notification (tmux DCS passthrough inside `tmux`). Files:
  `src/tui/clipboard.ts`, `src/tui/copytext.ts`, `src/tui/attention.ts` (new),
  `src/tui/terminal.ts`, `src/tui/app.ts`, `src/tui/keymap.ts`; tests
  `tests/tuicopy.test.ts` (18), `tests/tuiattention.test.ts` (11) and
  `tests/tuiintegration.test.ts`. See `docs/keyboard.md` → “Copying and
  terminal attention”.
- **TUI external editor** — `Ctrl+G` opens the draft in `$VISUAL`/`$EDITOR`
  (Windows notepad fallback, POSIX refusal), resolves an absolute executable,
  refuses workspace binary planting, spawns without a shell, caps the read-back
  at 256 KiB, normalizes BOM/CRLF/final newline, and restores the terminal on
  every path. Idle-only. Files: `src/tui/externaleditor.ts` (new),
  `src/tui/terminal.ts`, `src/tui/app.ts`, `src/tui/keymap.ts`; tests
  `tests/tuiexternaleditor.test.ts` (20). See `docs/keyboard.md` → “Compose and
  send”.
- **Undo lifecycle** — bounded retention (newest 20 per session, 30-day age),
  orphan-blob GC with shared-blob survival, POSIX mode restoration
  (best-effort ownership), and
  `sessions undo <name> [--run <id>] [--apply|--discard] [--json]` previewing by
  default; `DELETE` returns additive `blobs_removed?`/`gc_diagnostics?`. Files:
  `src/workspacehistory.ts`, `src/server.ts`, `src/cli.ts`, `src/clihelp.ts`;
  tests `tests/workspaceundo.test.ts` (42), `tests/serverundo.test.ts` (9),
  `tests/sessionscommands.test.ts` (18). See `docs/cli-reference.md` →
  `sessions undo` and “Run-scoped file undo”.
- **Web Fork from here…** — an operator bubble sends `{seq}` to the existing
  fork route and opens the new session; the source stays byte-identical, the
  lineage link and `<source> (fork)` title are unchanged, and the action is
  unavailable while a run is live. Files: `web/src/sessionFork.ts`,
  `web/src/components/ChatView.vue`, `web/src/App.vue`; tests
  `web/tests/sessionFork.test.ts` (9). See `docs/quickstart.md` → step 7.
- **Session-recovery hardening** — the torn-tail repair is a full
  `{size, mtimeMs, ino}` compare-and-swap before rename (mismatch throws a
  retryable `SessionError` and leaves every byte intact), and a fork of a
  torn-tail source copies only the complete-line prefix byte-exactly; interior
  corruption still fails 422. Files: `src/session.ts`, `src/sessionfork.ts`;
  tests `tests/session.test.ts` (14), `tests/sessionfork.test.ts` (23),
  `tests/sessionapi.test.ts` (11).
- **Doctor MCP config + MCP env wiring** — `doctor` gains a read-only
  `mcp-config` check (unset = skip, invalid = bounded warn, valid = pass with
  sorted server names; never starts a server or prints spec values), and
  `TWO_BROTHERS_MCP_CONFIG` is now honored by `run`/`chat`/`tui`/`serve`/
  `--dry-run` (flag > env, blank = not configured). Files: `src/doctor.ts`,
  `src/clihelp.ts`, `src/cli.ts`; tests `tests/doctor.test.ts` (45),
  `tests/cliergonomics.test.ts` (48).
- **Per-preset context windows** — provider presets gain additive
  `context_window` (positive safe integer; 0/absent = unknown), validated on
  GET/PUT/POST and preserved across unrelated saves. Compaction precedence:
  explicit `ServerOptions.compaction` > run-level flag/env > persisted >
  smaller of the two resolved preset windows, reported honestly as
  `source: "preset"`. Settings → Providers gains the labelled input. Files:
  `src/presets.ts`, `src/settings_store.ts`, `src/config.ts`,
  `src/runtime.ts`, `src/server.ts`, the web provider/compaction model and
  `ProvidersSection.vue`; tests 143 backend + 45 web focused. See
  `docs/quickstart.md` → step 3 and `docs/cli-reference.md` → `GET/PUT
  /api/settings`.

## Shipped 2026-11-09 (wave 27: session directory layout)

`src/sessionlayout.ts` adds the opt-in project/session directory store
(`<project>/<stem>/session.jsonl` + `meta.json` + `events.jsonl`), a compat
reader for the legacy flat layout, and `sessions migrate` (copy-first,
workspace-grouped, idempotent, conflict-reporting). The server materialises a
session directory before the run manager persists its first event; metadata,
runtime sidecars, the TUI picker, search/export, fork/rewind and the web API
all follow both layouts. Flat stores remain the default until migrated; the
public session name and envelope bytes are unchanged. Tests:
`sessionlayout`, `serverlayout`, `sessionsmigrate`.

## Shipped 2026-11-09 (wave 28: settings schema versioning)

`sessions/settings.json` now carries a top-level `"version": 1` on every write
(`SETTINGS_SCHEMA_VERSION`) and exposes it additively as `schema` on
`GET /api/settings` as `{version, supported, writable}`. A legacy v0 file reads
exactly as before and normalizes on its next save; invalid/negative/string
versions read fail-soft and normalize too; unknown top-level sections survive a
v0/v1 write. A document from a newer release stays readable (known sections and
`GET` keep working) but every settings write refuses with
`SettingsSchemaVersionError` (HTTP 409 from the server's settings write routes)
instead of downgrading it. An existing-but-unreadable document additionally
reports `readable: false`/`reason`, reads fail-soft, and refuses every write
with `SettingsReadOnlyError` (HTTP 409) without touching its bytes.
Tests: `tests/settingsschema.test.ts` (new), `tests/settings.test.ts` and
`tests/server.test.ts`. See `docs/cli-reference.md` → `GET/PUT
/api/settings`, `docs/session-storage.md` → "Settings file schema" and
`docs/troubleshooting.md`.

Also shipped in wave 28:

- **Spill retention** — `SpillStore.stats()`/`prune()`, `two-brothers spill
  stats|gc --older-than <n>m|h|d [--dry-run] [--json] [--force]`, and the
  opt-in `serve --spill-retention-days <n>` startup pass. The gc pass takes
  the store's single-writer lock and deletes only validated regular spill
  files strictly older than the cutoff.
- **Line-ranged `workspace_read_file`** — optional 1-based `offset` and
  `limit` page through a large file with bounded memory; results add
  `lines`/`total_lines`/`eof`/`next_offset`, while calls without either keep
  the historical byte-identical head+tail result. A page that clips its first
  line keeps `next_offset` on that line and adds `next_char_offset`, passed
  back as `char_offset` to recover the rest of the line and then the following
  lines; `eof` stays honest and no surrogate pair is split.
- **Advisory repeat-tool guard** — ported from deepseek-harness's
  `repeat-tool-reminder` (MIT); identical consecutive calls get a gentle
  reminder at 3 and detailed reminders at 5/8, appended only to the
  model-facing tool result. `TWO_BROTHERS_REPEAT_GUARD=off` disables it.
- **Workspace instructions** — workspace-bound runs load root-level
  `AGENTS.md` then `CLAUDE.md` (bounded, deduped, quote-neutralized, framed as
  untrusted project guidance) into a `## Workspace instructions` prompt
  section; `TWO_BROTHERS_PROJECT_INSTRUCTIONS=off` disables it.
- **Web message quotes** — assistant/operator bubbles gain a selection-aware
  `quote` action that appends a capped Markdown blockquote to the current
  unsent composer draft, never replacing it or submitting.

Wave 28 review hardening (same release): a symlink/junction spill root is
refused instead of followed (a same-user swap during a pass is outside the
check); a failed writer-lock write removes only the file it created, and
reclaim/release compare file identity plus a per-acquisition nonce so racing
writers cannot delete each other's lock; an existing unreadable `settings.json`
reads fail-soft but refuses writes with 409; a character-clipped
`workspace_read_file` line continues through `next_offset` plus a
`next_char_offset` relative to it, and every page advances at least one whole
code point; session deletion
requires a writable settings document and refuses with 409 under a
future-version or unreadable one (keeping the session); `spill stats` rejects
gc-only flags; `spill gc` human output reports stale temp files with the
correct dry-run wording; and the startup spill retention runs after a
successful bind.

Deferred follow-ups: a settings backend choice (JSON now, optional
`node:sqlite`), session-format version headers plus frozen adjacent
migrations, optional compression, projection caches for large corpora,
optional per-cwd grouping for unlinked sessions (the current directory layout
uses `_global`), and a migration backup/rollback helper.

## Shipped 2026-11-10 (wave 29: permission presets, prompt rewrite, live cache)

- **Permission presets in TUI and Web** — deepseek-harness-style named presets
  now sit over the existing persisted `approval_policy.mode`; the mode remains
  the only enforcement/wire value. `read-only` → `readonly`, `ask` (Always
  ask) → `ask`, `workspace-write` → `edits`, `danger-full-access` → `allow-all`;
  `custom` is derived-only for a future unmatched value. `PermissionPreset` /
  `PERMISSION_PRESET_INFO` / `normalizePermissionPreset` live in
  `packages/harness/src/permissions.ts`; the web mirror is
  `web/src/approvalPolicy.ts`. The TUI `/permission` dialog and buttons now
  speak presets (legacy mode names stay accepted), `/settings` shows the
  effective preset and gains a **Permissions…** action, and the web Settings
  section is renamed **Permissions** with preset cards, the stored mode named
  on each card, the inline full-access warning, an `initialSection` deep-link,
  and a clickable composer permissions seat. No protocol/PUT change: the API
  still accepts the four modes only.
- **System prompts optimized** — `shared/prompts.json` (and the packaged copy,
  byte-identical) now states the actual fixed cycle (consult/delegation →
  proposal/deliverable → review → decision), the payload-only contract, the
  required numeric `confidence`/array types, the review `points` revision
  path, decision `dissent`/`accepted_proposals`, and one coherent reply
  format: one JSON object, a fenced JSON block accepted (removing the old
  "no markdown wrappers" vs fenced-example contradiction). Tool headings and
  payload examples stay code-owned; the base file intentionally contains no
  literal fenced JSON block so node-kind inference cannot confuse a
  file-provided block with the generated example (wave 30 moved the example to
  the user turn; `e2e/faults.ts` reads the structural `Requested payload:`
  marker first).
- **Live cache percentage** — an additive `usage` runtime/stream event is
  emitted after every cooperation node, before `run_end` (same counters as the
  terminal event). `RunManager` folds it into the live run record, the web
  footer shows tokens/cache % while a run works or waits, and the TUI status
  bar/side panel/result line show `cache N%` (clamped; writes are never
  counted as hits). `usage.prompt_tokens` is the family-normalized prompt
  total (Anthropic: uncached + read + written; Gemini: prompt count;
  OpenAI-compatible omits it because input already includes cache reads), so
  the percentage is `cached / prompt_tokens` rather than the old
  `cached / input_tokens` that inflated Anthropic/Gemini and could exceed
  100%; `cache_write_tokens` is shown as `write N` when billed. Anthropic's
  three `cache_control` breakpoints and the provider-family cache accounting
  are unchanged.

Tests: `tests/approvalmodes.test.ts` (+3 preset tests),
`tests/tuiapprovalmodes.test.ts` (7, presets + `/settings` link),
`tests/harness.test.ts` (live usage event), `tests/runtime.test.ts` (live
record usage), `tests/prompts.test.ts` (payload-format/no-fence contract),
`web/tests/approvalPolicy.test.ts` (+4 preset tests),
`web/tests/composerStatus.test.ts`, `web/tests/permissionsUi.test.ts` (4
source-level wiring assertions), `web/tests/usageCache.test.ts` (4
family-normalized percentage tests). See `docs/cli-reference.md` → Approval modes,
`docs/quickstart.md`, `docs/troubleshooting.md` → Permissions/Tokens and
prompt cache, and `docs/keyboard.md`.

## Shipped 2026-11-12 (wave 30: kind-stable system prompts for cache reuse)

The per-node few-shot payload block moved from the system prompt onto the
request's transcript user turn. `REPLY_FORMAT_MARKER` (`Requested payload:
<kind>`), `replyFormatBlock` and `withReplyFormat` live in
`packages/harness/src/harness.ts` and are exported for embedders. With the same
role, tool belt, skills and workspace instructions, consult → review → decision
now sends a byte-identical system prompt, so OpenAI/DeepSeek implicit caching
and Anthropic's system breakpoint can reuse the prefix. A different belt (the
senior's verify slice vs. its empty-belt decision call) still starts a new
prefix. The block rides on the opening transcript turn; in tool loops it stays
there while tool results follow, and `DELEGATION_DIRECTIVE` remains the final
suffix of the junior work request. On a repair re-ask the block is appended to
the repair instruction itself, closest to the requested reply. `e2e/faults.ts`
parses the last structural marker first and keeps the old
system-fence/transcript fallbacks. Tests:
`tests/payloadrepair.test.ts` (strict-valid block, no system fence,
non-mutating/replacing helper, marker-collision and directive preservation,
one system prompt per role with the same belt, repair-tail coverage); focused
suites plus the full package suite, CLI E2E and fault injection.

Also shipped in wave 30:

- **Failed-run partial usage** — a non-abort harness failure now carries the
  merged usage of the provider calls that already succeeded as a non-enumerable
  `usage` property (`HarnessRunFailure` / `runFailureUsage`), and
  `RunManager` folds it onto the failed record before `run_error`/`run_end`.
  Failed runs therefore keep real spend/cache evidence on the live record,
  in the terminal event, and after a sidecar-rebuild restart; a failure before
  any call still reports zeros, never invented numbers. Tests:
  `tests/graph.test.ts`, `tests/runtime.test.ts`, `tests/server.test.ts`.
- **Full-access risk confirmation (web)** — selecting Full access in Settings →
  Permissions no longer switches immediately. A deepseek-style confirmation
  panel requires the acknowledgement checkbox before `allow-all` is emitted;
  Cancel keeps the previous preset. The TUI keeps its explicit-button plus
  warning-toast flow, and a typed `/permission danger-full-access` remains
  explicit consent. Tests: `web/tests/permissionsUi.test.ts` (source-level
  confirmation wiring), web suite/build.

## Shipped 2026-11-12 (real `auto` + Senior solo decision)

Todo item 4 is shipped: `auto` is no longer a consult alias. The owner-approved
design (`.tmp/research/auto-solo-design.md`, six owner decisions recorded in
its §10) landed as model-declared routing with deterministic harness
guardrails:

- **Routing** — a new `senior_route` entry node runs ONLY when the mode is
  `auto`: one plain senior call requesting the code-only `route` payload
  `{route: "solo"|"consult"|"work", reason}` (strict schema, relaxed strict
  parse, exactly one repair re-ask). An unparseable route fails closed to
  `consult` with ONE warning (exit 0); a provider failure fails the run
  normally with usage attached. Guardrail G1 downgrades work→consult when no
  workspace is bound (recorded in the marker, the event and a warning); G2
  always honors solo (structurally read-only); G3 routes once per run and
  consumes no rounds; G4 leaves operator precedence unchanged.
- **Solo** — `senior_route → senior_solo → END`: the senior answers alone on
  its read-only CONSULT belt (helpers kept, mutations and `todo_write`
  filtered; tool-less configs keep the exact plain path), bounded by
  `MAX_CONSULT_TOOL_ITERATIONS`. The code-only `SOLO_DECISION_DIRECTIVE`
  forbids claiming unperformed work. Legal per PROTOCOL.md §5 ("decide on its
  own"); zero protocol/schema/prompts.json changes.
- **Recording** — the route WHY rides a `[[AUTO ROUTE]] <route> — <reason>`
  marked message envelope (compaction/steer convention), the additive
  `auto_route` runtime event, `HarnessResult.autoRoute`, the CLI `--json`
  `auto_route` key, and the run record's additive `route`/`route_reason`
  fields (derived from the persisted event, so they survive a sidecar
  rebuild; `mode` keeps the requested `auto`).
- **Surfaces** — `/mode` accepts `auto` in chat/TUI/web/base commands;
  command frontmatter may pin `auto`; the web projects the marker as a
  neutral "Auto · Senior chose …" activity (the runtime event covers the
  live window and is shadowed once the envelope lands), the solo decision
  renders through the existing highlighted decision row, and the composer's
  Auto copy is truthful. Rewind excludes the marker in both the backend and
  the web mirror, so cuts never land mid-cycle.
- **Byte-stability** — explicit consult/work runs never enter routing; the
  `tests/modebytes.test.ts` golden suite (captured on the pre-change tree)
  pins their full provider requests, transcripts and envelope logs. The mock
  provider is UNCHANGED (PROTOCOL.md §11): mock auto deterministically
  demonstrates the fail-closed consult path; solo demos use scripted
  providers (the `auto-solo` browser scenario).

Tests: `tests/autoroute.test.ts` (31), `tests/solo.test.ts` (24),
`tests/modebytes.test.ts` (12), server/runtime/CLI/TUI/web extensions and the
`auto-solo` browser scenario. No new runtime dependencies.

## Open items (deferred)

- **models.dev catalog browse/import (medium)** — kimi-code fetches
  `https://models.dev/api.json` (10-minute cache, 10-second timeout) and falls
  back to a release-build snapshot; its provider manager lists catalog
  providers, infers the wire family from `type`/`npm`/id, imports the selected
  models, rejects proprietary protocols, and asks for a base URL when the
  catalog has none. Our seed table now covers the common subscription plans,
  but a catalog browser would scale beyond it. Proposed first slice: a
  read-only `GET /api/models-dev/providers` summary endpoint and
  `GET /api/models-dev/providers/{id}` model list (server-side cache, no key
  handling), then reuse the existing `POST /api/providers` create path by
  prefilling the Add-provider form; no new write route and no runtime
  dependency on models.dev. Keep a curated snapshot or seed fallback for
  offline use. Do not assume one catalog provider is one wire family: OpenCode
  Go routes some models to Anthropic/Google endpoints through per-model
  `provider.api` overrides, while our preset is one wire family. The public
  catalog is ~6 MB / ~9 000 models, so never ship it whole or fetch it on every
  settings render. Tests need an injected fetch and a fixed fixture.
- **OAuth-only subscription sign-in (large)** — GitHub Copilot, OpenAI Codex
  (ChatGPT Plus/Pro) and the Kimi Code managed login use OAuth/device-code
  flows and token refresh, not a static API key. Supporting them means a login
  flow, a refresh-locked token store and provider-specific request headers;
  the subscription seeds deliberately cover API-key plans only.
- **Per-turn prompt-cache statistics** — pi's `cache-stats.ts` exposes
  per-turn cache-miss/write stats beyond the run total. Our footer now shows
  the normalized run percentage and write count; a per-call breakdown in the
  prompt-audit rows would make cache misses attributable to a node/tool belt.
  Requires an additive `prompt_audit` field or a new display-only event, so it
  was not folded into the kind-stable prompt change.
- **Remaining key-binding surfaces** — wave 16 shipped the web's three
  modifier global chords (command palette, find, shortcut reference) with the
  Settings → Keyboard capture UI, and wave 19 shipped the TUI's three global
  chords (command palette, shortcut reference, draft stash) via
  `tui --keys-file`/`TWO_BROTHERS_TUI_KEYS_FILE`. Still fixed by design:
  composer/typing keys (IME- and picker-sensitive), picker/overlay
  navigation, dual-Escape stop, `?`/search/scroll keys, approval-panel keys
  and the find bar. The TUI also gained opt-in automatic reload of the
  captured keys file in wave 23 (`tui --keys-watch` /
  `TWO_BROTHERS_TUI_KEYS_WATCH=1`, off by default) alongside `/keys show` and
  `/keys reload`; an in-TUI key-binding editor is still absent. Extending
  rebinding there needs a per-surface conflict model.
- **WAN fault / long-soak coverage (manual)** — WAN latency/load and
  real-provider fault injection are not covered by the offline gates, and long
  soaks are an operator choice; keep those manual (they need a real endpoint
  and real time budget). The serve-level tooling exists:
  `packages/harness/e2e/serve-load.ts` (`npm run test:e2e:serve-load`)
  exercises the real RunManager/worker pool/queue over HTTP in mock or real
  modes; recorded 2026-11-08 against the owner's LM Studio (workers 1,
  runs 2): 2/2 completed in 230.8 s, run 2 queued 117.7 s behind run 1.
- **`serve` config-derived auto-compaction is silently inert (medium,
  verified 2026-11-08)** — `two-brothers serve` accepts `--compact`,
  `--compact-threshold <chars>`, `--compact-threshold-tokens <n>`,
  `--compact-keep-recent <chars>` and `--context-window` (plus the
  `TWO_BROTHERS_COMPACT*` env vars) but its runs never receive the resulting
  compaction settings: only the manual `POST /api/sessions/{name}/compact`
  route falls back to the resolved config, so the documented proactive
  auto-compaction never fires on the primary (serve/web) surface. Evidence and
  a decision-complete fix sketch (one shared `compactionSettingsFromConfig`
  helper used by `run`/`chat`/`tui`/`serve`, explicit `ServerOptions`
  still winning) are in `.tmp/research/wave24-proposals.md` §A1: the A/B probe
  `.tmp/research/probe-serve-auto-compact.mjs` reports config-only
  `{envelopes: 5, summaries: 0}` vs an explicit `compaction` option
  `{envelopes: 4, summaries: 1}`, and a real
  `serve --compact-threshold 200` run produced a session with 0 summaries
  while the identical CLI `run` produced 1. Not fixed here. Shipped in wave 24:
  `serve` now derives the same settings, see `src/server.ts` and
  `docs/cli-reference.md`.
- **CLI `run --mode work` without a workspace binds no tools** (medium,
  verified 2026-11-08; **shipped in wave 24**) — the CLI has no workspace
  surface (`--workspace` is TUI-only; `serve` is the workspace-bound path), so
  a `run --mode work` gives the junior an empty tool belt while the senior's
  review/decision can still accept a fabricated deliverable as verified. Live
  evidence: `.tmp/livecheck/wave23/REPORT.md` §S2 / finding F1 — against LM
  Studio `lfm3-1.7b`, the run exited 0 with the deliverable "Created
  /workspace/hello.txt …", the review verdict `accept` and the decision "File
  creation verified and accepted", yet no file existed and no tool was called.
  Wave 24 ships the honest notice:
  `packages/harness/src/cli.ts::workModeWithoutToolsWarning`, called from
  `runOnce` after MCP/plugin binding, emits one
  `[warn] work mode has no tools bound: ...` stderr line whenever the junior's
  belt (`shared` + `junior`) is empty — a senior-only tool does not suppress
  it — while stdout, exit codes and `--json` output stay unchanged. Tests:
  `packages/harness/tests/cli.test.ts`; docs: `docs/cli-reference.md` §Modes.
- **Subagents** — **phase 1 shipped 2026-11-12 for `serve`/web:** the Senior
  can spawn one isolated read-only single-role helper through the `subagent`
  tool. The child has its own context, a fresh provider instance, read-only
  workspace tools, a bounded task/report and a durable transcript under
  `<sessions-dir>/subagents/`; the parent stream carries `subagent_*` events
  and the web header shows a live tree with a read-only child drawer. The
  child cannot mutate, run shell, recurse, or receive follow-ups. Remaining
  phases: mutating child tools with child-tagged approvals, `send_message` /
  `interrupt_agent` / `list_agents` controls, async completion/wake (the
  parent currently waits for the bounded report), a TUI tree, forked-context
  children, deeper nesting, per-call model/effort overrides (the operator's
  Settings → Models & roles → Subagent route already fixes the child route) and
  cost/cache roll-up into the parent view. The protocol stays unchanged;
  children are internal executions, not second protocol peers.
- **Stacked-dialog mask-click (web, non-blocker)** — **blocked on upstream**
  (evidence updated 2026-11-08): naive-ui fires `mask-click` for clicks that
  land inside a stacked second dialog, so every dialog's handler must ignore
  those via the `web/src/modal.ts` guard. Installed and latest published
  naive-ui are both 2.45.3 (2026-08-27); its `BodyWrapper` unconditionally
  binds a capture-phase `clickoutside`, `Modal.handleClickoutside` calls
  `onMaskClick` for every outside click, and the `evtd` trap only checks the
  first dialog's own body — while the 2.45.2 release explicitly reverted the
  earlier mask-level click design. Re-check after the next naive-ui release
  (> 2.45.3); optionally file an upstream repro (stacked `n-modal`s: a click
  inside the second fires the first's `on-mask-click`).
