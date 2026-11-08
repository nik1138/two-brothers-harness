# AGENTS.md — `packages/harness/`

Guidance for coding agents working in the publishable TypeScript port.
Project overview and root rules live in `../../AGENTS.md`; the port plan
lives in `../../docs/history/ts-rewrite-plan.md`.

## What this is

The **primary implementation** of the Two Brothers harness and the
publishable npm package (`@two-brothers/harness`) — TypeScript in the
style of pi / deepseek-harness: cooperation core + execution tier.
Sources started as a copy of the `typescript/` zero-dep reference, but
this tree is where all product work lands. The original Python prototype
was **removed from the repository on 2026-11-04**; it is not a parity
target and its sources live only in git history. `typescript/` remains
the protocol reference and is not modified by work here either.

## Layout

- `src/` — package sources (public API via `src/index.ts`)
- `tests/` — `node:test` suites; `run-all.ts` is the in-process runner
  (`npm test`); `npm run test:spawn` = `node --test tests/`
- `shared/prompts.json` — copy of the repo-root `shared/prompts.json`
  (loaded at runtime relative to the module; must stay in sync — the
  protocol tests check parity when the repo-root copy is reachable)
- `scripts/sync-web.mjs` — copies the repo's built `web/dist` into
  `<package>/web` (pure Node, no deps, builds nothing); `prepack` runs it so
  the npm tarball ships the UI (`web` in `files`)
- `web/` — generated copy of the built Vue app (gitignored; created by
  `npm run sync-web`, served by `createServer` when present)
- `dist/` — build output (tsc), not committed

## Rules specific to this tree

1. **Dependencies are curated, not casual.** Every runtime dependency must
   be listed with a justification in `docs/history/ts-rewrite-plan.md`
   ("Dependency ledger"). Currently: `zod` (payload validation — the
   pydantic-style analogue) and `@earendil-works/pi-mcp` (MCP client;
   pulls one pure-JS transitive dep `cross-spawn`).
   devDependencies (typescript, @types/node) are free.
2. **Build:** `npm run build` (tsc → `dist/`, declarations on). Sources keep
   `.ts`-extension imports; `rewriteRelativeImportExtensions` rewrites them
   in the emit. `engines` is Node ≥ 22.19 (the pi-mcp floor; Node 22 LTS
   baseline — see the dependency ledger); native type stripping covers the
   `node src/*.ts` / `node e2e/*.ts` dev runs.
3. **The protocol contract is owned by `PROTOCOL.md` + `shared/protocol.schema.json`.**
   Same rule as the other trees: contract change → PROTOCOL.md → schema →
   all implementations → all test suites.
4. **Contract invariants** (from the plan — do not regress): byte-stable
   transcript markers; tolerant parse → strict validate → sanitize bridge;
   dense session `seq`, resume never re-appends; permissions fail closed.
5. **Out of scope here:** web sources (`web/`) and e2e browser tests. Do not
   port them into this tree yet; the built web app is only *copied in* at pack
   time (`scripts/sync-web.mjs`) so npm consumers get the UI. (`settings_store.ts` + `secretbox.ts` are ported — product-shell
   module 1; `runtime.ts` + the `RuntimeEventStore`/`RunApprovalBroker`
   half of `runevents.ts` are ported — module 2: worker-pool run manager,
   per-session event sidecars, approval broker; `server.ts` + `metadata.ts`
   + the `WorkspaceRegistry` + `cli.ts serve` are ported — module 3:
   HTTP + SSE on plain `node:http`. All no new runtime
   deps.) **MCP is in scope and shipped:** `src/mcp.ts`
   (`loadMcpTools` on `@earendil-works/pi-mcp`, `--mcp-config` on
   `run`/`chat`, optional per-server `"role": "shared"|"senior"|"junior"`
   defaulting to junior) feeding the `toolScopes` registry
   (`shared`/`senior`/`junior`) in `src/harness.ts`; the legacy
   `tools`/`seniorTools` options keep working and map to the junior /
   senior scopes (legacy `tools` also keep the verify-name filter).
   Model-facing names are namespaced per pi (`mcp__<server>__<tool>`,
   64-char cap, stable sha256 suffix on truncation/sanitize collision) with
   the readable `server/tool` pair in `McpToolSet.displayNames`; one result
   is clipped to 20 KiB with the shared truncation marker; each call has a
   per-call `timeoutMs` (default 60 s, per-server `"timeoutMs"` override)
   that surfaces as an `MCP tool error: timed out …` result. Namespacing,
   the cap and the timeout are deliberate TS-first divergences from
   the original prototype (raw names, no cap/timeout). pi-mcp is pinned at the exact
   `1.5.0` (ledger).
   **Plugins are in scope and shipped (module 4):** `src/plugins.ts`
   (fail-soft `plugins/` loader + `PluginContext`, the original
   prototype's plugin contract port) —
   ES-module plugin files (`[a-z0-9_]+`, `.ts`/`.mts`/`.mjs`, plain dynamic
   `import()` with a `?v=N` reload cache-bust) exposing
   `register(ctx)`. **Plugins are shared-by-default** (owner decision
   2026-11-03): a tool that declares no scope joins the `shared` scope of
   the `toolScopes` registry, so the senior verify slice and the junior belt
   both receive it. The v2 surface opts in per tool: `add_tool(name,
   handler, { description, parameters, scope, timeoutMs })` — `{ scope:
   "senior" | "junior" }` routes the tool to that belt only
   (`effectiveToolScope`), and the options form's `parameters` JSON-Schema
   subset (`src/toolschema.ts`) turns on dispatch-time validation
   (`validateToolArgs`; a bad call becomes a
   `plugin tool error: invalid arguments: …` result). The legacy positional
   `role` is still validated and recorded for plugin-source compatibility
   but stays shared (deprecation note in `ctx.diagnostics`), and the legacy
   `params_schema` shorthand stays unvalidated. **Hooks**
   (`ctx.on_hook`: `session_start`, `session_end`, `before_tool_call`,
   `after_tool_call` — `HOOK_NAMES`) dispatch in registration order through
   the fail-soft, monotonic-deny `dispatchHook`;
   `HarnessOptions.hooks` wires them into a run: `before_tool_call` may
   rewrite `args` or deny (a deny emits `tool_completed` status `blocked`
   and returns the denial text as the tool result), `after_tool_call` may
   rewrite the result before it is compacted/reported, and the session
   hooks bracket the run (`completed`/`cancelled`/`failed`). A broken hook
   lands on its plugin's diagnostics and never breaks a run. **Per-plugin
   options:** a settings entry is a bare name/path or `{path, options}`,
   validated against an optional exported `configSchema` (a rejected object
   loads as `{}` plus a diagnostic); an optional exported `manifest` is
   recorded (its `description` is the last description fallback).
   `PluginManager.bindingsFor(active, workspace)` is the per-run binding —
   `{tools, toolsByScope: {shared, senior, junior}, hooks, diagnostics}`
   (`toolsFor` stays the flat compatibility view; tools are only built for
   workspace-bound runs, hooks are always collected). The settings shape is
   one shared `plugins` list (persisted top-level in
   `sessions/settings.json`; entries may be `{path, options}` objects; a
   legacy per-role `{"senior": [...], "junior": [...]}` section or top-level
   `plugins_senior`/`plugins_junior` keys are merged on read — dedup,
   order preserved — and dropped on the next save). The deprecated
   `TWO_BROTHERS_PLUGINS_SENIOR/JUNIOR` env vars stay accepted as additive
   aliases merged into the shared set and are never persisted.
   `GET /api/plugins` serves the discovery view with `roles: ["shared"]`
   for any plugin carrying tools, plus an additive `diagnostics` list (load
   notes + the last run's binding notes) only when non-empty; per-plugin
   enable/disable rides `PUT /api/settings` `plugins` (the legacy per-role
   object is also accepted and merged; `{path, options}` entries reach
   `setSettings` before the reload), and a plugins-carrying settings save
   reloads the manager. **CLI parity:** `run`/`chat`/`serve` load plugins
   too (`--plugins-dir`, env `TWO_BROTHERS_PLUGINS_DIR`, default
   `<cwd>/plugins`; pinned like every env var, never persisted). A load
   failure is fail-soft and diagnostics print only under `--verbose`;
   plugin tools need a workspace, so only workspace-bound `serve` runs get
   them (the CLI has no workspace), while hooks apply everywhere.
   The repo example is `plugins/notes.mts`. No new runtime deps.
   **Per-role provider endpoints are shipped (Stage 18):**
   `runtime.ts::resolveRoleEndpoints` (precedence per role: role env pair >
   shared env pair > named preset `provider_ref` > role manual fields;
   a dangling ref warns + falls back to the manual fields) feeds
   `HarnessOptions.endpoints` in `src/harness.ts`, so each role's provider
   is built from its own baseUrl/apiKey/model — the old shared-`Config`
   collapse (junior wins) is gone. Presets carry the additive `kind`
   (default `"openai-compatible"`) + `models` fields; the CLI grows
   `--senior-base-url/--senior-api-key/--junior-base-url/--junior-api-key`
   (env `TWO_BROTHERS_SENIOR_BASE_URL` etc., pinned like the other env
   vars — never persisted). Design note:
   `research/harnesses/provider-settings-design.md`.
   **Context compaction is shipped (v2):** `src/compaction.ts` (pi's
   algorithm ported per `research/harnesses/pi-durable-mcp-chord.md` +
   `research/pi-adoption.md` O3 — `selectCutPoint`/`selectCut`,
   `serializeConversation` with the 2000-char cap, pi's pinned cold prompt
   plus its update prompt verbatim; char budgets, plus the token mode below).
   `HarnessOptions.compaction` (`thresholdChars` auto trigger between
   state-machine nodes at `thresholdChars - reserveChars`, `reserveChars`
   reply headroom default `DEFAULT_RESERVE_CHARS` = 8000 chars clamped to
   half the threshold, `keepRecentChars` verbatim tail, `force` =
   `--compact`, `summarizerRole` default senior) runs the summarizer
   through the configured provider — never a second HTTP client — and is
   fail-soft (a failure warns via `result.warnings` and keeps the full
   context). Repeated compaction is incremental: a summary already in the
   summarized prefix is passed as `<previous-summary>` (pi's update
   prompt) instead of summarized cold, so the context still carries
   exactly one summary event. A split-payload cut folds an envelope larger
   than the keep-recent budget into the summary with head+tail
   serialization and an explicit truncation marker, so one huge delegation
   can never make a session uncompactable. A `ProviderContextOverflowError`
   from any provider call (plain or tool-loop) triggers one
   compact-and-retry against the rebuilt context; a second overflow
   surfaces. The summary is a `message` envelope marked by
   `COMPACTION_SUMMARY_PREFIX`; `SessionStore.rewrite()` (temp-file +
   rename) rewrites a compacted session so `--resume` keeps working;
   protocol envelopes and session JSONL shape are untouched. CLI:
   `--compact`, `--compact-threshold <chars>`, `--compact-keep-recent
   <chars>` (+ `TWO_BROTHERS_COMPACT*` env).
   **Token accounting is shipped (Wave 3 sub-wave 3b):** `estimateTokens`
   is a zero-dep chars/token heuristic (ASCII 4:1, CJK/full-width/emoji
   1 token per char, other non-ASCII 2:1, rounded up — a documented gauge,
   not a tokenizer). `CompactionSettings` adds `contextWindow`,
   `thresholdTokens`, `reserveTokens` (default `DEFAULT_RESERVE_TOKENS` =
   2000) and `keepRecentTokens` (default 10000). Mode resolution is
   deterministic: tokens iff `contextWindow` or `thresholdTokens` is set
   (> 0), else the char path above is unchanged (back-compat). Token mode
   triggers at `(thresholdTokens ?? contextWindow) - reserveTokens`
   compared with `estimateTokens(renderTranscript())`, derives the tail
   (≤ trigger/2) and summary (≤ trigger/4) budgets in tokens, and caps the
   summary by estimated tokens; `selectCutPointTokens` walks the same cut
   in token units, while serialization, the split-payload cut and its
   2000-char cap stay char-based. Overflow recovery uses token budgets
   sized to the window when one is known; a second overflow still
   propagates. `ProviderConfig.contextWindow` carries the run-level window
   and all three adapters ignore it on the wire. CLI:
   `--compact-threshold-tokens <n>` (+
   `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS`), `--context-window <n>` (+
   `TWO_BROTHERS_CONTEXT_WINDOW`); `--verbose` failure warnings name the
   unit and the measured size. Tests: `tests/compactiontokens.test.ts`.
   Preset-level context windows are a follow-up (`docs/backlog.md`).
   Compaction has no counterpart in the original prototype — a
   documented TS-first divergence (BACKLOG "Context compaction"). No new
   runtime deps.
   **Structured prompt sections + per-call prompt audits are shipped
   (Wave 2 sub-wave B2):** `harness.ts` assembles each role's system prompt
   as the base `shared/prompts.json` text plus pi-style `## Available tools`
   (the exact model-facing belt the call offers — MCP namespacing applied,
   one line per tool) and `## Using tools` sections; an empty belt emits
   "You have no tools; answer from the transcript." instead of leaving the
   model guessing. Both `shared/prompts.json` copies stay byte-identical —
   the sections exist only in code. The junior's work-mode deliverable
   message carries `DELEGATION_DIRECTIVE` after the byte-stable transcript,
   making the delegation actionable. Every provider call records a
   `PromptAuditEntry` (role, node kind, section names, tool names,
   system/user char lengths — never prompt bodies) on
   `HarnessResult.promptAudits` and emits the same entry as a
   `prompt_audit` typed runtime event, immediately before the call, so
   `two-brothers serve` SSE consumers see the audit live (additive event;
   the event store/sidecar and the protocol envelopes are unchanged).
   `--verbose` prints the trail. Tests: `tests/promptsections.test.ts`,
   the SSE case in `tests/server.test.ts`, and the hermetic
   `e2e/server-prompt-audit.ts`. No new runtime deps.
   **Web-run status contract is shipped (Wave 2):** `RunManager` emits
   `run_status: waiting` when a run parks on an operator approval and
   `run_status: running` when it resolves (the cause event —
   `approval_requested` / `approval_resolved` — is emitted first); the
   events stay `{type, status, run_id, at}`, so protocol envelopes are
   untouched. `RunRecord` carries `mode` — the request's mode, else the
   resolved config default — through `POST /api/runs` and
   `GET /api/runs[/{id}]`. Run records remain in-memory, but
   `GET /api/runs/{id}` for an unknown id falls back to
   `RuntimeEventStore.findRun()` (sorted sidecar scan) and rebuilds a
   minimal terminal record from `run_end` + `run_error`, so a failed
   run's error survives a backend restart; `task` and `mode` are not
   event fields and come back as "". Tests:
   `tests/server.test.ts` ("Web-run status contract" section).
   **Provider error classification is shipped (Wave 2):** `src/provider.ts`
   carries an ordered `PROVIDER_ERROR_REGISTRY` (ported from pi-ai's
   `utils/{retry,provider-retry,overflow}.ts`, MIT): 408/409/429/5xx and
   transport wording retry; other 4xx, quota/billing exhaustion, context
   overflow and unclassified errors fail fast with the provider's message
   instead of burning the retry budget. A retryable response's `Retry-After`
   (delta-seconds or HTTP-date, capped at 120 s) replaces that attempt's
   fixed backoff, and context-overflow payloads raise
   `ProviderContextOverflowError` (never retried) so callers can compact.
   The owned contract is unchanged: default 6 retries, 2/4/8/16/30 s cap,
   abort-aware waits, per-attempt timeout, `--retries`/`--timeout` env+flags.
   Tests: `tests/retryregistry.test.ts`. No new runtime deps.
   **Robust edits + per-file mutation queue are shipped (Wave 2):**
   `src/workspace.ts` ports pi's `edit-diff.ts` and
   `file-mutation-queue.ts` (MIT). `workspace_edit_file` tries a byte-exact
   match first (byte-exact, the original prototype's behavior), then pi's normalized view (line endings,
   trailing whitespace per line, Unicode quotes/dashes/spaces), then an
   indentation-insensitive line block whose replacement is re-based onto the
   file's indentation. A non-unique match fails with a line-numbered
   `ambiguous` error unless `replace_all` is set; a BOM and the file's line
   ending style are preserved, untouched lines keep their original bytes,
   and `makeDiff` (difflib-compatible unified diff) is unchanged.
   write/edit/delete of the same resolved path serialize through a
   module-level promise queue keyed by realpath (call order, symlink-aware;
   Windows keys are case-folded); reads never take the queue.
   Tests: `tests/editqueue.test.ts`. No new runtime deps.
   **Structured-payload repair + exemplars are shipped (Wave 4, S1):**
   every structured node reply (`consult`, `proposal`, `delegation`,
   `deliverable`, `review`, `decision`) is checked against the strict zod
   schema (`src/payloads.ts::strictPayloadIssues`) after the tolerant parse
   and gets exactly ONE repair re-ask. The repair turn is a byte-stable
   marked `message` envelope from `"user"`
   (`[[REPAIR_REQUEST]]` … `[[/REPAIR_REQUEST]]`, `buildRepairRequest`,
   issues clipped to `REPAIR_ISSUE_CHARS`) appended to the shared context
   and the session JSONL; the request resends the conversation
   OpenAI-style (bad reply as an assistant turn, repair instruction as a
   user turn). A still-bad reply falls back to sanitize + defaults + one
   "unstructured model reply" warning — the tolerant boundary never throws
   and `--max-rounds` is untouched. Kind-specific prompt assembly appends
   one tiny, strict-valid fenced example per kind (`PAYLOAD_EXAMPLES`,
   `harness.ts`, code only — `shared/prompts.json` stays byte-identical).
   Tests: `tests/payloadrepair.test.ts`. **Relaxed strict parse is shipped
   (same lane, fix 2):** `payloads.ts::relaxedStrictPayload` accepts any JSON
   object in a raw node reply — bare, fenced, prose-wrapped, after a non-JSON
   thinking block, stray braces and all — when it passes the same strict
   check (zod + protocol-required fields); `harness.ts::structuredReply`
   runs it via `strictReplyCheck` before spending the one repair re-ask, so
   valid bare/fenced JSON never repairs or warns needlessly, while
   malformed/schema-invalid replies still repair exactly once and degrade
   with one warning. Transcript markers and the tolerant parse/sanitize
   pipeline are untouched. Tests: `tests/relaxedparse.test.ts`.
   **Skills are shipped (Wave 4, S2b + integration):** `src/skills.ts`
   (`discoverSkills(roots)` over `<root>/<name>/SKILL.md` and loose `.md`
   files, hand-rolled frontmatter with `name`/`description`/`scope`/
   `tools`, `SkillCatalog.skills` sorted, diagnostics never thrown;
   `renderSkillsSection(catalog, role)` → the pi-style
   `## Available skills` list or `null`; `renderSkillBody(skill)` → the
   `<skill name="…">` block). Scopes are `shared` (default) / `senior` /
   `junior`, so a senior-only checklist never leaks into the junior prompt.
   `HarnessOptions.skills` makes `assembleSystemPrompt` append the section
   plus one invocation line (`SKILLS_GUIDANCE`) and records the section
   name in the prompt audit / `PROMPT_SECTION_SKILLS` — only when the role
   actually has skills, so prompts with nothing configured stay
   byte-identical. CLI roots: `--skills-dir` (repeatable), then
   `TWO_BROTHERS_SKILLS_DIR` (OS path list), then `<cwd>/skills` and
   `~/.two-brothers/skills`; the server uses the same defaults (or
   `ServerOptions.skillsDirs`) and serves metadata only via
   `GET /api/skills` (`{skills: [{name, description, scope, tools, file}],
   diagnostics}`, never bodies). Bodies are advertised, not injected up
   front: a `<skill name="…">` request in a structured reply is delivered as
   a `<skill-loaded name="…">` … `</skill-loaded>` `message` envelope from
   `"user"` (`deliverSkillRequest` in `src/harness.ts`: at most three per
   run, each skill once, only skills visible to the acting role; unknown
   names inject nothing). Tests:
   `tests/skills.test.ts`, `tests/skillinvoke.test.ts`,
   `tests/integration.test.ts`. No new runtime deps.
   **Seeded presets + onboarding are shipped (Wave 4, S2d + integration):**
   `src/presets.ts` carries a curated seed table (openai, deepseek,
   anthropic, gemini, openrouter, lmstudio, custom) whose keys are env-var
   NAMES (`api_key_env`), never literals. `mergeSeedPresets(stored)` layers
   stored presets on top by name (user edits win in place),
   `presetById(id)` looks a seed up, `presetApiKey(preset)` resolves the env
   name at use time. The server lists the merged table at
   `GET /api/providers` (masking keeps `api_key_set`; values never leave),
   accepts seed ids as `provider_ref`, resolves them through
   `resolveRoleEndpoints`, and `PUT /api/providers/{seed}` materializes a
   stored override (the seed's env-backed key keeps working while the
   override has no literal key). CLI: `models --base-url <url>
   [--api-key|--api-key-env]` lists what an OpenAI-compatible endpoint
   reports (`provider.listModels()`), and `onboard` writes per-role
   settings from a preset id or manual fields (interactive or
   `--non-interactive`; tested with piped stdin). Tests:
   `tests/presets.test.ts`, `tests/cliergonomics.test.ts`,
   `tests/integration.test.ts`. No new runtime deps.
   **Cost visibility is shipped (Wave 4, S2d):** `src/cost.ts` is a small
   hand-maintained USD-per-1M price table (`MODEL_PRICES`) plus
   `priceForModel` / `estimateCost` with tolerant model matching (exact,
   last `/` segment, then longest prefix, so dated snapshots resolve);
   unknown models return `null` instead of a made-up `$0`. `run` prints
   `cost: $0.0000 (in … / out … tokens)` when both roles resolve to the
   same priced model (`estimateRunCost`/`costLine`) and `--mode json`
   carries `cost` (null when unknown). Tests: `tests/cost.test.ts`,
   `tests/cliergonomics.test.ts`. No new runtime deps.
   **`--max-tokens` output caps are shipped (Wave 4, S2d + integration):**
   `Config.maxTokens` (`--max-tokens`, env `TWO_BROTHERS_MAX_TOKENS`) with
   per-role overrides (`maxTokensForRole`, `TWO_BROTHERS_SENIOR/JUNIOR_MAX_TOKENS`)
   rides `ProviderConfig.maxTokens` to the OpenAI `max_tokens`, Anthropic
   `max_tokens` (its 4096 default applies when unset) and Gemini
   `maxOutputTokens`. The CLI builds capped role providers itself, and
   `providerFromEndpoint` (per-role endpoint / server path) forwards
   `maxTokensForRole` too, so `serve` and preset runs honor the cap.
   Tests: `tests/cliergonomics.test.ts`, `tests/integration.test.ts`.
   No new runtime deps.
   **Streaming run events are shipped (Wave 4, S3a):** `src/runstream.ts`
   is the in-process event channel (`StreamEvent`: `run_status`
   started/completed/failed/cancelled, one `envelope` per appended
   envelope, `repair` with the node kind, `tool_call`/`tool_result` with
   `ok`/`error`/`blocked`, and a terminal `result` holding decision, usage,
   warning count and session file). `HarnessOptions.onStreamEvent` is the
   sink — deliberately NOT `onEvent`, which is the typed `RuntimeEvent`
   hook, and not `onEnvelope`, which the server's SSE bridge uses; the
   stream is purely additive. Emitters: `publishEnvelope` (every append —
   node replies, repair turns, initial task, compaction summary),
   `repairReply`, `invokeTool` + the unknown-tool branch of `toolLoop`, and
   `run()` for the lifecycle; `emitStream` swallows a throwing consumer so
   the run never depends on it. `toNdjsonLine` emits one JSON object per
   line under dsh §R3's bounds — string fields over `STREAM_FIELD_CHARS`
   (8192 chars) become `<clipped N chars>`, an over-`STREAM_LINE_CHARS`
   (32768) line has its longest fields clipped until it fits (chars, not
   dsh's bytes), and the `result` record is not exempt from the caps (a
   consumer may assume every line is bounded). CLI `run --stream` prints
   the lines as they happen and exits 0/1 like the other modes; the human
   summary/cost line are suppressed (the `result` record carries usage —
   use `estimateCost`), and `--stream` combined with `--json`/
   `--json-events`/`--mode print|json` is a usage error (exit 2). Tests:
   `tests/streaming.test.ts`. No new runtime deps.
   **Feature integration is shipped (Wave 4, integration lane):** the four
   lanes above are wired together — `tests/integration.test.ts` is the
   hermetic end-to-end suite (hook veto, result rewrite, per-role scope
   routing, skills-in-prompt gating, `GET /api/skills`, `maxTokens` on the
   endpoint path, seeded presets on the server); `tests/run-all.ts`
   registers every suite.
   **Slash commands are shipped (Wave 5, wiring lane):** `src/commands.ts`
   discovers flat `<root>/<name>.md` prompt templates (name = file stem,
   `^[a-z0-9][a-z0-9_-]*$`; hand-rolled `description`/`argument-hint`/
   `mode` frontmatter; fail-soft diagnostics; first root wins a name
   collision) and `expandCommand` substitutes `$ARGUMENTS`, `$1`..`$9` and
   `$$` in one literal pass (no shell, no re-expansion). `matchCommand`
   parses `/name args`, and the chat REPL dispatches it before submitting:
   a known name becomes that turn's task and its `mode` (when set) overrides
   the cooperation mode for that turn only; an unknown name prints
   `unknown command: <name>` plus a `/commands` hint and is never submitted.
   `/commands` and `/help` list `name — description (argument-hint)`.
   Discovery is once per REPL session (the plugin collection stays
   per-turn); roots are repeatable `--commands-dir`, then
   `TWO_BROTHERS_COMMANDS_DIR` (OS path list — the skills convention), then
   `<cwd>/commands` and `~/.two-brothers/commands`; diagnostics print only
   under `--verbose`. The server re-discovers on demand and serves metadata
   only at `GET /api/commands`
   (`{commands: [{name, description, argumentHint, mode?, file}],
   diagnostics}`, never bodies; `--commands-dir` also rides `serve`). Tests:
   `tests/commands.test.ts`, `tests/cliwiring.test.ts`,
   `tests/apicommands.test.ts`.
   **Plugin-contributed MCP servers are wired (Wave 5, wiring lane):**
   `ctx.add_mcp_server(name, config)` and a plugin module's exported
   `mcpServers` object feed `PluginBindings.mcpServers`;
   `mergeMcpConfig(base, servers)` folds them under the `--mcp-config` base
   (a configured name wins, then the first plugin; bad names/configs become
   diagnostics) and the merged `{mcpServers}` feeds `loadMcpTools`
   unchanged. `run`/`chat` bind plugins before the MCP block, merge, then
   fold the plugin tool scopes; `serve` gains `ServerOptions.mcpConfig`
   (the CLI now forwards `--mcp-config` to `createServer`), merges per run
   after `bindingsFor` and before the harness, folds the MCP role buckets
   into `toolScopes`, and closes `mcp.client` in a `finally` around
   `harness.run`. A missing configured file warns and keeps the plugin
   servers. Tests: `tests/pluginmcp.test.ts`.
   **Token-level streaming is wired (Wave 5, wiring lane):**
   `run --stream --stream-tokens` sets `HarnessOptions.streamTokens`, so
   every provider text delta arrives as a `token` NDJSON record
   (`{type, role, delta, at}`) interleaved with the envelope/lifecycle
   records (`toNdjsonLine` bounds apply). The flag is valid only with
   `--stream` (otherwise a usage error, exit 2, like the `--stream` ×
   `--json` conflict) and the pinned env default is
   `TWO_BROTHERS_STREAM_TOKENS=1`. `MockProvider` fakes the delta stream
   (`MOCK_DELTA_CHARS`, `emitMockDeltas`). Tests:
   `tests/streamingtokens.test.ts`, `tests/cliwiring.test.ts`.
   **The TUI is the interactive product (T0–T3 shipped):** a bare
   `two-brothers` in an interactive terminal opens the full-screen TUI
   (`tui [task]` stays the explicit form; `chat` remains the plain REPL and
   piped no-arg usage is unchanged). The screen is assembled from the lane
   modules: `model.ts` block transcript (full unclipped text, streaming
   drafts finalized by envelope id), `view/` screens (welcome, transcript,
   composer, two-line responsive status bar, palette, help, pickers, dialog,
   toasts), `editor.ts` grapheme-aware multiline input with history and
   bracketed paste, `keymap.ts` as the single registry behind Ctrl+P, `?`,
   slash input and `tui --help`, and `terminal.ts` bracketed paste + resize
   repaint + full restoration on every exit path. Turns run outside the
   key-read await with an `AbortController`; Escape/Ctrl+C follow the safe
   precedence overlay-close → cancel turn → clear composer → confirm quit.
   The status bar shows mode/models/session/cwd plus context/tokens/cache/
   cost/elapsed with honest unknowns (`cost unknown` when the merged usage
   cannot be attributed to one priced model). Session resume and per-role
   model pickers reuse the existing session/provider services and refuse
   unsafe changes while a turn runs; tool calls/results pair by the
   additive optional `callId`/`args`/`result` stream fields (NDJSON
   consumers stay compatible). Non-TTY refusal stays exit 2 with no escape
   bytes. `renderFrame`/`reduceStreamEvent` remain as the legacy pure test
   seams. Tests: `tests/tui*.test.ts` lanes plus the assembled-app
   `tests/tuiintegration.test.ts`, all registered in `tests/run-all.ts`.
   No new runtime deps.
   **TUI prompt history + draft stash (P1):** `src/tui/historystore.ts`
   persists submitted tasks across restarts at
   `~/.two-brothers/tui-history.json` (env override
   `TWO_BROTHERS_TUI_HISTORY_FILE`; versioned `{version: 1, entries}`,
   newest-last, 100 entries, 16 384 chars each, consecutive dedupe, atomic
   temp-file + rename, fail-soft on every IO/parse error). The app loads it
   once at startup and seeds the editor history in order; only accepted task
   submissions (typed, slash-template, or `tui "<task>"`) are appended, never
   a draft/recall that was not submitted. Ctrl+O (the `stash` registry
   command, so `?`/F1 and Ctrl+P expose it) moves one draft between the
   composer and an in-memory one-slot stash with toasts; the slot survives
   session switches. Tests: `tests/tuihistory.test.ts`.
   **Graceful `serve` shutdown + local-request guards are shipped
   (2026-11-04 hardening):** `cli.ts serve` traps SIGINT/SIGTERM and runs
   `shutdownServe(app)` — stop accepting connections, cooperatively stop
   queued/running/waiting runs (stop resolves pending approvals as deny),
   bounded 5 s grace (`SERVE_SHUTDOWN_GRACE_MS`) for in-flight runs to
   unwind (MCP clients close in the run's `finally`), then end SSE and
   close; flushed session JSONL is never rewound. `server.ts` enforces
   local-request guards **only while every binding is loopback**:
   non-loopback `Host` (DNS-rebinding defense) and non-local browser
   `Origin` on state-changing methods are refused with 403; a non-loopback
   `--host` logs a warning that the guards are off. Session-name routes
   take flattened `.jsonl`-only names. `run_shell` clamps model-supplied
   timeouts to 1–600 s (`MIN/MAX_SHELL_TIMEOUT_S`; default 30 s,
   non-positive = no timer). Tests: `tests/serveshutdown.test.ts`,
   `tests/security.test.ts`. No new runtime deps.
   **Waves 7–16 (2026-11-08) added, all in `src/` + `tests/` with hermetic
   coverage:** persisted bounded reasoning in run events and session runtime
   sidecars (`runevents.ts`, `runtime.ts`; web/TUI replay); Anthropic extended
   thinking (`--thinking-budget` / `TWO_BROTHERS_THINKING_BUDGET`: request
   `thinking`, signed/redacted block capture and verbatim tool-loop passback;
   `provider.ts`, `context.ts`, `harness.ts`, `config.ts`, `tests/thinkingpassback.test.ts`);
   `TWO_BROTHERS_JSON` aligned with `--json` (machine object, explicit-mode
   precedence); command-scoped `--thinking-budget` parsing; the docs↔CLI
   drift guard (`tests/clidocs.test.ts`, part of `npm test`); real-socket
   fault-injection runner (`e2e/faults.ts`, in the smoke gate and CI); opt-in
   manual real-network load runners (`e2e/load.ts`, `e2e/serve-load.ts`);
   two-platform CI (ubuntu Node 22/24 + Windows Node 24). No new runtime
   deps.

## Commands

Dev/test scripts run the `.ts` sources directly via Node's native type
stripping — **Node ≥ 22.6 required** for development; `engines` declares the
Node ≥ 22.19 floor the built package supports (see the dependency ledger).
The built `dist/` output is plain ES2022.

```powershell
cd packages/harness
npm install
npm run build        # tsc -> dist/
npm run sync-web     # copy ../../web/dist -> ./web (run web build first)
npm run typecheck    # noEmit, includes tests
npm test             # in-process node:test runner
npm run test:spawn   # node --test tests/
node dist/selftest.js   # offline gate (after build)
node src/cli.ts run "..." --provider mock   # dev run via type stripping
npm run test:e2e:cli       # hermetic offline CLI subprocess E2E (mock)
npm run test:e2e:cli:dist  # same, against built dist/cli.js
npm run test:e2e:faults    # real-socket fault injection (loopback, in the smoke gate)
npm run test:e2e:load      # OPT-IN manual real-network load runner (needs an endpoint)
npm run test:e2e:serve-load # OPT-IN manual serve-level load/soak runner (mock or real endpoint)
npm run pack:check         # publint + attw on the packed tarball
```
