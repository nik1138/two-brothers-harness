# Changelog

All notable changes to `@two-brothers/harness` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Provider presets master–detail in Settings → Providers**: the preset list
  is now identity-only (name, Senior/Junior role badges, key-state dot,
  `Customized`/`custom` tags), and the selected provider's settings appear
  inline directly below its row — Base URL, masked write-only API key, model
  ids as editable tags, an `Advanced` wire-kind disclosure, dirty-gated
  `Save changes`, an inline add card, and a delete confirm that names the
  roles which would switch to Manual. `GET /api/providers` gained additive
  `seed` and `customized` booleans so a client can tell a pristine built-in
  seed from an edited override or a custom entry (all other fields and
  routes unchanged). Pure model in `web/src/providerSettings.ts`, tested in
  `web/tests/providerSettings.test.ts` (web 195/195).
- **First-party base commands** (`src/basecommands.ts`): the built-in slash
  commands adapted from the two reference harnesses — prompt templates
  `plan`, `goal`, `feedback` (literal `$ARGUMENTS`/`$1..$9`/`$$` expansion,
  `consult` mode, `requiresArguments` usage errors) and action commands
  `compact`, `export`, `permission`, `status`, `mode`, `new`, `help` that a
  surface performs instead of submitting a task. English plus the reference
  Chinese aliases, priority ordering, `baseCommandUsage`, and
  `baseCommandMetadata()` for `GET /api/commands`. `expandTemplate` is shared
  with discovered commands (`expandCommand` delegates), so a `<name>.md`
  template and a base command with the same body render byte-identical task
  text; a discovered name shadows its base namesake. Tests:
  `tests/basecommands.test.ts`.
- **Server base-command surface**: `GET /api/commands` additively returns
  `baseCommands` (metadata only); run submission (`POST /api/runs` and legacy
  `POST /api/run`) expands base prompt commands with their mode override,
  answers a missing required argument with `400 usage: /plan <objective>`, and
  answers an action command with a 400 that points at the surface action
  instead of creating an empty turn; unknown/path-like slash lines stay
  verbatim. New `POST /api/sessions/{name}/compact` compacts one session on
  demand (404/400/409 while a run is live, `200 {compacted:true,
  before_events, after_events}`, an honest `compacted:false` no-op, 502 on
  summarizer failure with nothing written) and rewrites the JSONL with dense
  `seq`. Tests: `tests/serverbase.test.ts`, `tests/apicommands.test.ts`.
- **Web composer command surface and UI cleanup**: the `/` menu merges the
  built-in catalogue (priority order, `action` badges, alias/description
  search) with discovered templates (a discovered name shadows its base
  namesake) and degrades to discovered-only against an older backend; prompt
  commands insert `/name ` and expand server-side, action commands are
  performed locally (`/compact` via the new route with a transcript reload,
  `/export` via the shared download flow, `/help`/`/status`/`/permission`
  dialogs, `/mode`, `/new`) and never submitted as runs. A single-source
  commands-and-shortcuts overlay opens on `/help`, `?` and `Ctrl/⌘+/`; the
  composer key contract is IME- and repeat-safe with `Ctrl/⌘+Enter`
  accelerated send, picker `Tab`/`Shift+Tab`, escape layering, and a 500 ms
  double-`Esc` stop. Pure modules `web/src/basecommands.ts`,
  `composerKeys.ts`, `shortcuts.ts`, `download.ts`; tests `web/tests/
  basecommands.test.ts`, `web/tests/composerKeys.test.ts` (web 177/177).
- **TUI built-in commands and picker cleanup**: `src/tui/basecommands.ts`
  adapts the shared catalogue (native keymap commands keep their names,
  discovered templates shadow base ones, built-ins ordered by priority),
  `src/tui/inputguard.ts` stops a held `Enter`/`Tab` from repeat-submitting,
  and the `/` picker groups `TUI commands -> Built-in prompts -> Built-in
  actions -> Slash commands` with `builtin`/`action`/`template` badges,
  alias search, a highlighted-row usage footer and `Tab`/`Shift+Tab`
  accept/dismiss. Prompt commands expand with the exact shared bytes and mode
  override; `/compact` runs a real in-process compaction between turns and
  rewrites the session, `/export [path]` writes canonical Markdown, `/status`
  and `/permission` show real state only, `/new` starts a fresh in-memory
  session, and refusals are explicit. The help overlay lists the built-ins.
  Tests: `tests/tuibasecommands.test.ts` (all TUI suites 289/289).
- **CLI chat REPL built-in commands**: `chat` dispatches the shared catalogue
  before discovered templates — prompt commands run with their mode override
  and usage errors, action commands are performed by the REPL (`/compact`
  with the configured summarizer and resume-safe dense-`seq` rewrite,
  `/export [path]`, `/status`, `/permission`, `/mode`, `/help`/`/commands`),
  `/new` is refused with guidance, and `help chat` documents the surface.
  Tests: `tests/cliwiring.test.ts`.
- **Relaxed strict payload parse** (payload fix 2): `relaxedStrictPayload`
  (`src/payloads.ts`) runs before the repair re-ask — a node reply that is a
  bare JSON object or a fenced block without the byte-stable markers is
  accepted when it passes the same strict zod validation; extraction is
  relaxed, the schema is not. Tests: `tests/relaxedparse.test.ts`.
- **Graceful `serve` shutdown**: SIGINT/SIGTERM run `shutdownServe` — stop
  accepting connections, cooperatively cancel queued/running/waiting runs
  (a stop resolves pending approvals as deny), give in-flight runs a bounded
  5 s grace window, then end SSE connections and close; flushed session
  JSONL is never touched. Tests: `tests/serveshutdown.test.ts`.
- **Session search and export**: `src/sessionsearch.ts` searches session
  titles and envelope payload strings (case-insensitive literal substring,
  whitespace-collapsed, bounded single-line snippets, newest sessions first,
  per-session and overall hit caps with an honest `truncated` flag) and
  renders a session as Markdown (header + one section per envelope, payloads
  bounded to 20 000 chars) or stable pretty JSON. `loadSessionDocs` reads
  `<sessions-dir>/*.jsonl` newest-first with metadata titles attached,
  skipping corrupt files fail-soft. CLI: `sessions search <query> [--json]
  [--limit N]` and `sessions export <name> [--format markdown|json]
  [--output <path>]`. Server: `GET /api/search?q=&limit=` and
  `GET|HEAD /api/sessions/{name}/export?format=` (download headers;
  400/404 as documented). The web workspace searches message content from
  the Ctrl+K palette and exports a session from its row menu. Tests:
  `tests/sessionsearch.test.ts`, `tests/serversearch.test.ts`,
  `tests/sessionscommands.test.ts`; CLI E2E grew to 16 scenarios.
- **TUI find-in-transcript**: `Ctrl+F` (or `/find [query]`) opens an inline
  find bar over the transcript — live literal case-insensitive filtering,
  `current/total` with an honest `+N` cap, `Enter`/`Down` next and
  `Shift+Enter`/`Up` previous (wrap), the active match marked in the block
  gutter and scrolled into view (block anchor), and `Esc` restoring the
  composer draft and scroll position exactly. `src/tui/view/findbar.ts` is the
  pure state/render module; the command and its scoped keys live in the shared
  keymap registry, so `?`/F1 help, `Ctrl+P` and `tui --help` list them.
  Tests: `tests/tuifind.test.ts`.
- **TUI span-level Markdown emphasis**: `src/tui/markdownstyle.ts` is now the
  single Markdown parser producing width-safe styled lines/spans (bold,
  italic, inline code, links, headings, lists, quotes, fences, diff markers),
  and `src/tui/transcript.ts` paints those spans on top of each row's tone
  through `Theme.paintEmphasis` (all SGR stays in `theme.ts`). Span-preserving
  wrapping in `src/tui/text.ts` keeps grapheme/East-Asian/emoji widths exact.
  `plainTheme`/`NO_COLOR` output is byte-identical to the previous plain
  renderer (frozen baselines plus a 1,200-document fuzz check); a color theme
  never changes row content or width. Tests: `tests/tuistyle.test.ts`,
  `tests/tuivisualmodel.test.ts`.
- **Workspace rename and operator ordering**: `WorkspaceRegistry.rename()`
  (trimmed, 120-character cap, order unchanged) and `reorder()` (exact
  permutation validation before any mutation) persist to
  `sessions/workspaces.json`, and `GET /api/workspaces` returns the operator
  order. Server: `PATCH /api/workspaces/{id}` and
  `PUT /api/workspaces/order` (400/404 as documented). The web sidebar gained
  a per-workspace actions menu (rename dialog, move up/down, optimistic
  reorder with rollback). Tests: `tests/workspaceorder.test.ts`,
  `tests/serverworkspaces.test.ts`, `web/tests/workspaceOrder.test.ts`.
- **Broker-level approval-repeat cap**: `RunApprovalBroker` now counts
  operator denials per identical `(action, target)` pair (the shell command
  for shell approvals; target normalization shared with the harness layer)
  and, after `APPROVAL_DENY_LIMIT` (default 2) denials, auto-denies the next
  identical request immediately — no pending entry, no `approval_requested` —
  emitting one additive `approval_auto_denied` runtime event
  (`{type, action, target, count, limit}`). This covers plugin/MCP approval
  consumers that the harness-level workspace-tool cap cannot see; the
  harness cap and its `auto_denied` result shape are unchanged, and
  allows/cancellations never count. New API: `RunApprovalBrokerOptions`,
  `approvalPairKey`, `approvalMatchTarget`, `normalizeApprovalTarget`,
  `broker.autoDenials()`. Tests: `tests/approvalbrokerdeny.test.ts`.
- **Composer mentions (`@`) and slash commands (`/`)**: run tasks may now
  carry `@skill:<name>` and workspace-file mentions (`@<relative/path>`,
  root-level files serialize as `@./name`). `src/mentions.ts` scans tokens
  strictly at word boundaries (emails/`@media` are never mentions), renders
  the byte-stable `<skill-loaded name="…">` and `<file path="…">` blocks
  with bounded content and truncation markers, and normalizes paths;
  `src/workspacefiles.ts` provides a bounded, fail-soft workspace file index
  (hidden/node_modules/sensitive/symlinks excluded, depth/count caps) plus
  ranking for the `@` picker. Server: `GET /api/workspaces/{id}/files`,
  and `POST /api/runs` / `POST /api/run` expand a known leading `/name`
  command (`matchCommand`/`expandCommand`, per-run mode override; unknown
  slash lines submit verbatim) and inject validated shared-skill and
  workspace-file blocks into the shared context before the task (role-scoped
  skills and unsafe paths are refused with actionable 400s, caps
  `MENTION_MAX_SKILLS`/`MENTION_MAX_FILES`/`MENTION_MAX_TOTAL_CHARS`). The web
  composer gained accessible `@`/`/` pickers (skills, workspace files,
  command templates; debounced file search, stale-response guard) and the
  TUI gained inline `/` and `@skill:` pickers with submit-time validation and
  context injection. Tests: `tests/mentions.test.ts`,
  `tests/workspacefiles.test.ts`, `tests/mentionswiring.test.ts`,
  `tests/tuipicker.test.ts`, `web/tests/mentions.test.ts`.
- **Thinking and response streaming**: providers now report reasoning deltas
  separately from visible text — `ChatOptions.onThinkingDelta`,
  `StreamState.thinking`, `ChatDeltaKind`, and per-adapter mapping
  (OpenAI-compatible `reasoning_content`/`reasoning`, Anthropic
  `thinking_delta`, Google `thought` parts; `MockProvider` streams
  `MOCK_REASONING` when a reasoning sink is present). `HarnessOptions.streamTokens`
  emits runstream `token` events with `kind: "text" | "thinking"` in arrival
  order from the single provider seam (plain calls, tool loops, overflow
  retries, repair re-asks); reasoning is observational and never enters the
  reply, usage, envelopes or session JSONL. Server:
  `POST /api/runs {"stream_tokens": true}` (strict boolean, default off) and
  `GET /api/runs/{run_id}/events` additionally writes named, id-less SSE
  frames `event: token` with `{type, run_id, role, kind, delta, at}` — the
  existing typed-event `id`/`?after` replay contract is untouched and tokens
  are never persisted. The web chat renders a collapsible live **Thinking**
  block and a streaming **Response** block (markdown, caret) that resolve
  into the projected envelope when it arrives; the TUI renders a bounded,
  dim live `THINKING` block above the streaming response. Tests:
  `tests/thinkingstream.test.ts`, `tests/servertokens.test.ts`,
  `tests/tuithinking.test.ts`, `web/tests/streaming.test.ts`.

### Security

- **Server local-request guards**: while every binding is loopback,
  requests with a non-loopback `Host` header (DNS-rebinding defense) and
  state-changing requests with a non-local browser `Origin` are refused
  with 403; binding a non-loopback address logs a warning that the guards
  are off. Session routes accept only flattened `.jsonl` names.
  Tests: `tests/security.test.ts`.
- **`run_shell` timeout clamp**: model-supplied timeouts are clamped to
  1–600 s (default stays 30 s; non-positive means no timer), so a huge
  model-invented value cannot park a run.

### Fixed

- **Settings → Appearance cards collapsed under Compact density**: the
  global compact-density rule targeting the sidebar footer's `.theme-option`
  switch also matched the Appearance dialog's cards (same class name), so with
  Compact active every card was forced to 24px and its labels/descriptions
  overflowed the border. The Appearance section now uses its own
  `.appearance-*` classes and the density rule is scoped to
  `html[data-density='compact'] .sidebar .theme-option`; a browser-E2E
  `appearance-density` scenario pins the card geometry in both densities and
  the preference across a reload.
- **Manual compaction/run mutual exclusion** (audit P1): `POST
  /api/sessions/{name}/compact` now reserves the session synchronously before
  the summarizer call and releases it in `finally`; run submission for a
  session being compacted is a 409 that creates nothing. Previously a run
  accepted during the summarizer window could have its envelopes dropped by
  the compaction rewrite (lost task line, non-dense `seq`). Two concurrent
  compacts are also serialized (one 200, one 409).
- **Compact route honesty**: the manual budgets derive from the resolved run
  config when `ServerOptions.compaction` is unset (serve-level `--compact-*`
  and `TWO_BROTHERS_COMPACT*` now apply); a client disconnect aborts the
  provider call (internal 499, no fake 502, no unhandled rejection); a corrupt
  session file is a stable 422 without leaking paths.
- **Typed non-ASCII aliases**: the web and the TUI no longer submit/run a
  typed `/目标 …`-style line (the shared ASCII slash parser can never resolve
  it) — they show a notice naming the canonical spelling and keep the draft.
- **Compaction summaries render neutrally**: the web transcript projects a
  `<summary>…</summary>` envelope as a quiet "Context compacted" system
  activity (collapsible, clipped, excluded from find/copy), and the TUI shows
  it as a dim `SUMMARY` block — never as an operator message; a resumed
  compacted session seeds the same marker in the TUI.
- **Web `/mode <arg>` and compaction lock**: typed `/mode consult|work`
  applies the composer mode (invalid/missing shows the usage and submits
  nothing), and the composer is honestly locked while a compaction runs.
- **Web workspace (UI shipped in the tarball)**: accessibility and
  keyboard-focus improvements across the chat, sidebar, composer, and
  Settings dialog, plus visible summaries of the effective per-role
  settings.
- **Web tooling**: `vue-tsc` pinned to `~3.0.2`, eliminating the minimatch
  advisory; `npm run build` keeps passing. A follow-up bump to 3.3 is
  tracked in `docs/backlog.md`.
- **Legacy SSE endpoint**: `GET /api/stream?session=<name>` now sends the
  standard SSE headers (`Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`), so proxies and
  EventSource clients treat the legacy tail as a proper event stream.
- **Installed CLI entry**: POSIX/npm `.bin` symlinks now resolve real paths
  correctly (`isCliEntry` compares canonical paths on both sides), so an
  installed `two-brothers` executes instead of silently exiting without
  output; regression coverage included.

## [0.0.1] — 2026-11-04

First public release.

### Added

- **Structured-payload repair + few-shot exemplars** (Wave 4, S1): every
  structured node reply (`consult`, `proposal`, `delegation`,
  `deliverable`, `review`, `decision`) is checked against the strict zod
  schema after the tolerant parse and gets exactly ONE repair re-ask. The
  repair turn is a byte-stable marked `message` envelope from `"user"`
  (`[[REPAIR_REQUEST]]` … `[[/REPAIR_REQUEST]]`) appended to the shared
  context and session JSONL; the retry resends the conversation
  OpenAI-style and a still-bad reply falls back to sanitize + defaults + a
  warning, without touching `--max-rounds`. Each kind's prompt assembly
  appends one tiny strict-valid `PAYLOAD_EXAMPLES` block (code only —
  `shared/prompts.json` stays byte-identical). New exports:
  `REPAIR_REQUEST_PREFIX`, `REPAIR_REQUEST_SUFFIX`, `REPAIR_ISSUE_CHARS`,
  `STRUCTURED_PAYLOAD_KINDS`, `strictPayloadIssues`, `buildRepairRequest`,
  `PAYLOAD_EXAMPLES`. Tests: `tests/payloadrepair.test.ts`.
- **Plugins v2: scopes, hooks, argument validation, options** (Wave 4,
  S2a): `add_tool(name, handler, { description, parameters, scope,
  timeoutMs })` — an explicit `{ scope: "senior" | "junior" }` routes a
  tool to one belt (`effectiveToolScope`; legacy positional `role` and
  scope-less tools stay shared per the 2026-11-03 owner decision);
  `parameters` (the `toolschema.ts` JSON-Schema subset) turns on
  dispatch-time validation (`validateToolArgs`); `ctx.on_hook` registers
  `session_start` / `session_end` / `before_tool_call` / `after_tool_call`
  handlers dispatched fail-soft with monotonic deny (`dispatchHook`,
  `HOOK_NAMES`, `collectHooks`); settings entries may be
  `{path, options}` validated against an optional exported `configSchema`;
  `PluginManager.bindingsFor` returns `{tools, toolsByScope, hooks,
  diagnostics}`, and `GET /api/plugins` gains an additive `diagnostics`
  list. `HarnessOptions.hooks` wires hooks into a run: `before_tool_call`
  may rewrite args or deny (a `blocked` tool result carrying the denial
  text), `after_tool_call` may rewrite the result, session hooks bracket
  the run. Tests: `tests/plugincore.test.ts`, `tests/integration.test.ts`.
- **Skills** (Wave 4, S2b + integration): `src/skills.ts` discovers
  `SKILL.md` trees and loose `.md` files (`discoverSkills`, hand-rolled
  frontmatter with `name`/`description`/`scope`/`tools`, fail-soft
  diagnostics), renders the pi-style `## Available skills` section per
  role (`renderSkillsSection`) and a `<skill name="…">` body block
  (`renderSkillBody`). `HarnessOptions.skills` adds the section plus one
  invocation line to a role's assembled prompt only when that role has
  skills (prompt bytes unchanged otherwise). CLI roots: repeatable
  `--skills-dir`, `TWO_BROTHERS_SKILLS_DIR` (OS path list),
  `<cwd>/skills`, `~/.two-brothers/skills`; the server serves metadata
  (never bodies) at `GET /api/skills`. Tests: `tests/skills.test.ts`,
  `tests/integration.test.ts`.
- **Seeded provider presets + onboarding commands** (Wave 4, S2d +
  integration): `src/presets.ts` (openai, deepseek, anthropic, gemini,
  openrouter, lmstudio, custom — env-var key NAMES only, never literals),
  `mergeSeedPresets` (stored presets override seeds by name),
  `presetById`, `presetApiKey`. The server lists the merged table at
  `GET /api/providers` (masking unchanged, `api_key_set` reflects env-backed
  keys), accepts seed ids as `provider_ref`, and materializes a stored
  override when a seed is edited. New CLI: `models --base-url <url>
  [--api-key|--api-key-env]` (`provider.listModels()`) and `onboard`
  (`--preset`, interactive or `--non-interactive`, piped-stdin safe).
  Tests: `tests/presets.test.ts`, `tests/cliergonomics.test.ts`,
  `tests/integration.test.ts`.
- **Cost estimation** (Wave 4, S2d): `src/cost.ts` — `MODEL_PRICES`
  (USD per 1M tokens), `priceForModel` (exact, last `/` segment, longest
  prefix), `estimateCost` (null for unknown models). `run` prints a
  `cost:` line when both roles share one priced model; `--mode json`
  carries `cost`.
- **`--max-tokens` output caps** (Wave 4, S2d + integration):
  `Config.maxTokens` (env `TWO_BROTHERS_MAX_TOKENS`) plus per-role
  overrides (`maxTokensForRole`); forwarded to OpenAI `max_tokens`,
  Anthropic `max_tokens` and Gemini `maxOutputTokens`, by the CLI's
  providers and by `providerFromEndpoint` (server / preset runs).
- **CLI + server wiring for plugins and skills** (Wave 4, integration):
  `run`/`chat`/`serve` load plugins (`--plugins-dir`, env
  `TWO_BROTHERS_PLUGINS_DIR`, default `<cwd>/plugins`; fail-soft,
  diagnostics only under `--verbose`), merge `toolsByScope` into the run's
  `toolScopes`, pass hooks into `HarnessOptions`, and build the skills
  catalog; the server uses `bindingsFor`, hands hooks + skills to every
  run, serves `GET /api/skills`, and applies per-plugin options with
  `setSettings` before reloading. New public exports for all four lanes;
  `tests/run-all.ts` registers every suite, with the hermetic
  `tests/integration.test.ts` covering the seams end-to-end.
- **The built web workspace ships in the npm tarball**: `scripts/sync-web.mjs`
  copies the repo's `web/dist` into `<package>/web` (pure Node, no deps), the
  `prepack` hook builds `dist/` and runs it, and `files` includes `web`. The
  server resolves the default static root from the module location — packaged
  `<package>/web` first, then the repo's `web/dist` — so `npx two-brothers
  serve` works without a separate frontend build. `resolveDefaultWebDist` is
  exported for hermetic tests.
- **Token-based compaction accounting** (Wave 3, 3b): compaction budgets
  can now track tokens against a provider's context window instead of
  chars. `estimateTokens(text)` (calibrated zero-dep heuristic, rounded
  up — documented as an estimate); `ProviderConfig.contextWindow`
  (`--context-window`, env `TWO_BROTHERS_CONTEXT_WINDOW`) feeds pi's
  trigger model: fire at `contextWindow - reserveTokens` estimated
  tokens, auto budgets derive in tokens (tail ≤ trigger/2, summary ≤
  trigger/4, reserve default 2000, clamped to half the threshold); the
  overflow→compact-and-retry recovery compacts to token budgets sized
  `contextWindow - reserveTokens` when a window is known. Explicit
  `--compact-threshold-tokens` (env `TWO_BROTHERS_COMPACT_THRESHOLD_TOKENS`)
  forces token mode with a custom threshold. With no window/threshold
  configured, today's char behavior runs unchanged (full back-compat —
  `--compact-threshold <chars>` keeps char semantics; serialization caps
  stay char-based as output shaping). New exports: `estimateTokens`,
  `selectCutPointTokens`, `CompactionUnit`, `compactionUnit`,
  `CompactionBudgets`, `compactionBudgets`, `compactionTriggerTokens`,
  `DEFAULT_RESERVE_TOKENS`, `DEFAULT_KEEP_RECENT_TOKENS`. Tests:
  `tests/compactiontokens.test.ts` (estimator rows, token trigger,
  budget derivation, reserve clamp, overflow recovery in token mode,
  char back-compat).
- **Multi-provider adapters** (Wave 3, W3-2): Anthropic Messages and
  Google Gemini adapters behind the existing `Provider` interface —
  `kind` (`openai-compatible`/`anthropic`/`google`) selects the wire
  adapter per role via `--provider-kind`/`--senior-kind`/`--junior-kind`
  (env `TWO_BROTHERS_PROVIDER_KIND`, `TWO_BROTHERS_SENIOR_KIND`,
  `TWO_BROTHERS_JUNIOR_KIND`), and on the server path a preset's `kind`
  rides `RoleEndpoint` to the adapter (kind pairs with a borrowed
  baseUrl only). Adapter errors classify through the Wave-2 registry
  (Anthropic `overloaded`/`rate_limit`/`api_error`, Google
  `RESOURCE_EXHAUSTED`/`UNAVAILABLE`/etc. retryable; rejected/auth rows
  fatal; overflow shapes → `ProviderContextOverflowError`); usage maps
  per family incl. Anthropic cache-read and Gemini cached-content math.
  `tests/adapters.test.ts` — 29 hermetic stub-fetch tests; the
  OpenAI-compatible path stays byte-stable.
- **Plugins shared by default** (Wave 3, W3-1): when a plugin is added
  it works for both brothers — plugin tools always join the shared
  scope; settings carry one top-level `plugins: string[]` (legacy
  per-role shapes and `TWO_BROTHERS_PLUGINS_SENIOR`/`_JUNIOR` merge
  fail-soft and are never persisted); the web SettingsDialog has a
  single Plugins multi-select. Per-role scoping is a documented future
  refinement.
- **Structured prompt sections + per-call prompt audit** (Wave 2, B2):
  `assembleSystemPrompt(base, tools)` appends pi-style `## Available
  tools` (the call's actual model-facing belt — MCP namespacing applied,
  one line per tool; explicit "You have no tools; answer from the
  transcript." when empty) and `## Using tools` directives to each role's
  base prompt, assembled in code — `shared/prompts.json` stays
  byte-identical; the work-mode junior's deliverable message carries a
  delegation directive after the byte-stable transcript. Every provider
  request records a `PromptAuditEntry` (role, node kind, section names,
  tool names, system/user char lengths — never prompt bodies) on
  `HarnessResult.promptAudits`; `--verbose` prints the trail. Motivated
  by a real-model LM Studio finding: with no tool mentions in prompts a
  small-model junior improvised workspace facts; with sections it either
  uses its tools or reports their absence.
- **Per-call prompt audits on the wire** (Wave 2, B2 follow-up): the
  audit entry is now also a typed runtime event — `RuntimeEvent` gains
  `prompt_audit` (additive; payload identical to `PromptAuditEntry` plus
  the usual `run_id`/`at`), emitted immediately before every provider
  call. `GET /api/runs/{id}/events` streams it live (the event store and
  its sidecar need no shape change; protocol envelopes and the protocol
  schema are untouched), and the web workspace's activity timeline shows
  a collapsible per-call row (role, node kind, section/tool counts, char
  lengths, name lists on expand). Tests: unit in
  `tests/promptsections.test.ts`, SSE in `tests/server.test.ts`, and the
  hermetic `e2e/server-prompt-audit.ts` suite (frame order around the
  tool/approval round, sidecar persistence, `?after=` replay).
- **Provider error classification + Retry-After** (Wave 2, A; port of
  pi-ai's `utils/{retry,provider-retry,overflow}.ts`, MIT): ordered
  `PROVIDER_ERROR_REGISTRY` — 408/409/429/5xx and transport wording
  retry; other 4xx, quota/billing exhaustion, context overflow and
  unclassified errors fail fast with the provider's message instead of
  burning the retry budget. A retryable response's `Retry-After`
  (delta-seconds or HTTP-date, capped at 120 s) replaces that attempt's
  fixed backoff. `ProviderContextOverflowError` (never retried) on
  overflow-shaped payloads. Retry contract otherwise unchanged (6
  retries, 2/4/8/16/30 s cap, abort-aware waits). New public exports
  including the registry, classifiers and `parseRetryAfterSeconds`.
- **Web-run status contract** (Wave 2, A): `RunManager` emits
  `run_status: waiting` when a run parks on an operator approval and
  `run_status: running` on resolution (cause event first) over SSE;
  `RunRecord` carries `mode` (request mode or resolved config default);
  `GET /api/runs/{id}` falls back to a sorted sidecar scan and rebuilds
  a minimal terminal record from `run_end` + `run_error`, so a failed
  run's error survives a backend restart. The web UI's polling
  workarounds were dropped on top of this contract (probe poll and
  client-side waiting patches removed; retry reuses the recorded mode).
- **Robust workspace edits + per-file mutation queue** (Wave 2, A; port
  of pi's `edit-diff.ts` + `file-mutation-queue.ts`, MIT): three-tier
  edit matching (byte-exact → normalized LF/NFKC/trailing-whitespace/
  Unicode-punctuation view → indentation-flexible whole-line blocks with
  re-based replacement), BOM and line-ending style preserved, ambiguous
  matches fail with line-numbered errors unless `replace_all`;
  write/edit/delete serialize through a module-level promise queue keyed
  by realpath (call order, symlink-aware, Windows case-folded); reads
  never take the queue.
- **Context compaction v2** (Wave 2, B1; pi port): split-payload cuts —
  an oversized envelope is serialized head+tail with an explicit
  middle-truncation marker, so a single huge delegation can no longer
  make a session uncompactable; incremental `<previous-summary>`
  chaining under pi's verbatim update prompt when re-compacting; reserve
  margin in the auto trigger (`reserveChars`, default 8000, clamped to
  half the threshold) so a post-compaction reply has headroom; overflow
  → compact-and-retry — a `ProviderContextOverflowError` from chat or
  tool calls compacts once and retries; a second overflow propagates.
  New exports: `selectCutPoint`, `compactionTriggerChars`,
  `compactionSummaryText`, `DEFAULT_RESERVE_CHARS`,
  `UPDATE_SUMMARIZATION_PROMPT`, `SerializeOptions`.
- **MCP hardening** (Wave 2, A): model-facing tool names are namespaced
  `mcp__<server>__<tool>` (sanitized, 64-char cap, stable sha256 suffix
  on truncation/collision; wire calls keep raw names) with a readable
  `server/tool` display mapping; results clipped to 20 KiB with the
  shared truncation marker; per-call timeout (60 s default, per-server
  `timeoutMs` override).
- **CLI first-run UX (modern-CLI conventions):** bare `two-brothers` on an
  interactive terminal drops straight into the `chat` REPL (piped/CI
  invocations still get the usage screen); `help`, `--help`, and `-h` print
  usage with exit 0; the REPL greets with the resolved provider/model/base
  URL per role and accepts `/help`, `/config`, `/exit`, `/quit` (the REPL
  loop reads stdin via async iteration, so piped scripts can drive it — the
  old question-per-line loop dropped lines that arrived mid-run).
- **Streaming run events + `run --stream`** (Wave 4, S3a): `src/runstream.ts`
  adds the in-process run stream — `StreamEvent` (`run_status`
  started/completed/failed/cancelled, one `envelope` per appended envelope,
  `repair`, `tool_call`/`tool_result` with `ok`/`error`/`blocked`, and a
  terminal `result` summary of decision + usage + warning count + session
  file) with `HarnessOptions.onStreamEvent` as the sink (named apart from
  the existing `onEvent` `RuntimeEvent` hook; the server SSE path and
  `onEnvelope` are untouched). Emission is fail-soft: a throwing consumer
  never changes a run's outcome. `toNdjsonLine` serializes one record per
  line under the dsh §R3 bounds — a field over `STREAM_FIELD_CHARS`
  (8192 chars) becomes `<clipped N chars>`, and a line over
  `STREAM_LINE_CHARS` (32768 chars) has its longest fields clipped until
  it fits (chars, not bytes — documented divergence). CLI `run --stream`
  prints those lines as events arrive and exits 0/1 per the usual status
  semantics; the human summary and cost line are suppressed (the `result`
  record carries usage, so consumers call `estimateCost`). `--stream` is
  its own output mode and exits 2 when combined with `--json`,
  `--json-events` or `--mode print|json`. New exports: `StreamEvent`,
  `HarnessResultSummary`, `toNdjsonLine`, `STREAM_FIELD_CHARS`,
  `STREAM_LINE_CHARS`, `clippedMarker`, the five record interfaces and
  their status unions. Tests: `tests/streaming.test.ts`. No new runtime
  deps.
- **Approval-deny repeat cap** (consumer-journey fix, 2026-11-04): a run
  tracks denied `(action, target)` pairs for the workspace mutation tools
  (`write` / `edit` / `delete` / `shell`). Once the operator has denied the
  same pair `APPROVAL_DENY_LIMIT` (2) times, the next identical request is
  auto-denied in the harness's tool path without invoking the workspace's
  `PermissionManager` broker, so a stubborn model cannot park a run in
  `waiting` indefinitely. Different targets and actions still reach the
  operator. The auto-denial reuses the workspace's `status: "denied"`
  representation (plus additive `auto_denied: true` and an explanatory
  `error`; `tool_completed` status `denied`, stream `tool_result` status
  `error`). Tracking is per run — a fresh `run()` starts with an empty map.
  New exports: `APPROVAL_DENY_LIMIT`, `approvalPair`. Tests:
  `tests/approvaldeny.test.ts`.
- **Provider timeout diagnostics** (consumer-journey fix, 2026-11-04):
  `BaseHttpProvider` emits ONE `[warn] provider attempt timed out after
  Ns; retrying (attempt k/n) — consider --timeout for slow models` line per
  timed-out attempt that will be retried, capped at
  `MAX_TIMEOUT_WARNINGS` (3) per provider instance. The sink is
  `ProviderConfig.onWarning` (default `console.error`: stderr only, so
  stdout stays parseable under `--mode json` / `--json` / `--stream`); the
  CLI passes `CliIO.error` through a three-per-run cap, so the warning
  appears WITHOUT `--verbose`. `ProviderTimeoutError` is the new typed
  per-attempt timeout (retryable; message unchanged). `serve --help` now
  documents `--timeout` and its retry warning. Tests:
  `tests/providerwarnings.test.ts`.
- **`GET /api/runs/{id}` rebuild marker** (consumer-journey fix,
  2026-11-04): a record rebuilt from the runtime sidecar after a backend
  restart carries the additive `"rebuilt": true` field; live in-memory
  records omit it, so the web UI can explain its blank `task` / `mode`
  fields. Tests: `tests/server.test.ts` (sidecar recovery section).
- **Plugin-contributed MCP servers** (research note
  `plugins-pi.md` R6): a plugin can now bring its own MCP server.
  `PluginContext.add_mcp_server(name, config)` records a declaration shaped
  exactly like one `--mcp-config` `mcpServers` entry (stdio
  `command`/`args`/`env`/`cwd` or streamable-HTTP `url`/`headers`, plus the
  optional per-server `role` — default `junior` — and `timeoutMs`); an
  exported `mcpServers` object on the plugin module is the declarative
  alternative and is ingested by `loadPlugins`. Both paths feed one
  per-context registry, and bad names/configs become diagnostics, never
  throws. New exports: `PluginMcpServer`,
  `collectPluginMcpServers`, `PluginBindings.mcpServers`,
  `LoadedPlugin.mcpServers`, `mergeMcpConfig`,
  `McpConfigFileShape`, `isValidMcpServerName`, `mcpServerSpecIssue`
  (`src/mcp.ts`): a configured entry wins a name collision, then the first
  plugin to contribute the name; collisions are reported. The merged
  `{mcpServers}` feeds `loadMcpTools` unchanged, so `mcp__<server>__<tool>`
  namespacing, the 20 KiB result clip and per-server role routing are
  untouched. Library level only — CLI/server wiring is a follow-up. Tests:
  `tests/pluginmcp.test.ts`. No new runtime deps.
- **Skill invocation** (Wave 4, S2b follow-up): the advertised
  `<skill name="…">` grammar now does something. After each structured
  reply is parsed (the `structuredReply` pass, after the payload-repair
  attempt), `deliverSkillRequest` scans the raw reply text for the request
  and appends the skill's markdown as a `message` envelope from `"user"`:
  `<skill-loaded name="…">` … `</skill-loaded>` (kimi-code's delivery
  convention; the body is used directly so it is not double-wrapped in
  `renderSkillBody`'s `<skill>` element). The envelope rides the ordinary
  append path — dense `seq`, session JSONL, `onEnvelope`, "Context events:"
  — so no new stream/runtime event types exist. Guards: at most three
  deliveries per run, each skill at most once, only catalog skills visible
  to the acting role (`shared` or the role's own scope), unknown names
  inject nothing, and the pass never throws. The node's own outcome is
  unchanged: the payload was parsed before delivery, which only enriches
  later turns. Tests: `tests/skillinvoke.test.ts`. No new runtime deps.
- **Token streaming** (Wave 4, provider lane): providers can now stream
  their reply as it is generated. `Provider.chat` gains an optional fourth
  argument (`ChatOptions { onDelta }`), and `ToolChatOptions` extends it, so
  `chatWithTools` streams too. When `onDelta` is set, each adapter requests
  the provider's SSE stream and calls the sink once per TEXT delta, in
  arrival order: OpenAI-compatible sends `stream: true` +
  `stream_options.include_usage` (deltas from `choices[0].delta.content`,
  usage from the final chunk), Anthropic sends `stream: true`
  (`content_block_delta` text, `message_start` + `message_delta` usage,
  `message_stop`), Gemini switches to
  `:streamGenerateContent?alt=sse` (`parts[].text` +
  `usageMetadata`; auth stays the `x-goog-api-key` header). Tool-call
  fragments reassemble per family. The resolved value, usage accounting and
  the retry loop are unchanged — the stream is assembled into the same
  response shape the non-streaming path parses. The per-attempt
  `AbortController` timeout bounds the WHOLE stream, and a mid-stream
  transport failure is classified by the existing
  `PROVIDER_ERROR_REGISTRY` (retryable transport wording) with deltas
  already delivered staying delivered. With no `onDelta` the request is
  byte-identical to before. `runstream.ts` gains
  `TokenStreamEvent` (`{type: "token", role, delta, at}`), and
  `HarnessOptions.streamTokens` (default false; active only with
  `onStreamEvent`) threads one delta sink through every role call —
  plain `chat`, the repair re-ask and the tool loop — so `token` records
  are additive to the existing envelope/lifecycle records. A giant delta is
  are clipped by `toNdjsonLine` like any field. New types/helpers:
  `ChatOptions`, `TokenStreamEvent`, `MOCK_DELTA_CHARS`,
  `emitMockDeltas` (`MockProvider` fakes a chunked stream when asked).
  Tests: `tests/streamingtokens.test.ts`. No new runtime deps.
- **TUI: a zero-dependency full-screen chat** (Wave 5, TUI lane):
  `two-brothers tui [task]` opens an alternate-screen chat over the same
  harness (`mock` or real providers), with a header bar, a bottom-anchored
  transcript, an input line and a status bar. The split keeps the tested
  core pure: `src/tui/render.ts` has no I/O (`wrapLine` colors by line
  kind without counting ANSI width, `renderFrame` windows wrapped rows
  from the bottom with `scrollOffset`, and same-state renders are
  byte-identical); `src/tui/terminal.ts` is a thin driver
  (alternate screen, cursor visibility, raw keypresses via
  `readline.emitKeypressEvents`, and `isTtyOk`) that refuses a non-TTY
  stdin; `src/tui/app.ts` owns the state machine and the per-turn harness
  construction (same config/session/plugin/MCP/hook/skill/compaction path
  as `chat`). Keys: Enter sends, Backspace edits, PgUp/PgDn scroll,
  Esc/Ctrl+C twice quits after a confirm hint. Slash input reuses
  `commands.ts` (`/help`, `/commands`, `/mode consult|work`, `/exit`, plus
  discovered commands); `--stream-tokens` appends token deltas in place,
  and `run_status` completed/failed updates the status bar. A piped stdin
  exits 2 with a clean message and no escape bytes. New exports:
  `renderFrame`, `wrapLine`, `pushLine`, `appendText`, `KIND_STYLE`,
  `RESET`, `ANSI`; `reduceStreamEvent`, `resolveTuiInput`,
  `envelopeToLine`, `runTuiApp`, `isTtyOk`, `createTerminal`. Tests:
  `tests/tui.test.ts`. No new runtime deps.
- **Wiring: slash commands in chat REPL, `--stream-tokens`, plugin-MCP
  merge in run/chat/serve, `GET /api/commands`** (Wave 5, wiring lane):
  the polish-wave modules are reachable from the product surface —
  the chat REPL dispatches `/name args` through `matchCommand` /
  `expandCommand` (a command's `mode` overrides that turn only; an unknown
  name is a hint, never a task), `run --stream --stream-tokens` emits
  `token` NDJSON records, `run`/`chat`/`serve` merge plugin-contributed MCP
  servers under `--mcp-config` (`mergeMcpConfig`, plugin tool scopes fold
  into `toolScopes`, `serve` closes the MCP client in a `finally`), and
  the server serves command metadata at `GET /api/commands`. The TUI lane
  reuses the same command catalog and token stream. Tests:
  `tests/cliwiring.test.ts`, `tests/pluginmcp.test.ts`,
  `tests/apicommands.test.ts`, `tests/tui.test.ts`.

### Changed

- **Plugins are shared by default** (owner decision 2026-11-03): every
  plugin tool joins the `shared` `toolScopes` scope, so both the senior
  verify slice and the junior belt receive it. Settings carry one shared
  top-level `plugins: string[]` list (persisted in `sessions/settings.json`
  and used by the single plugins multi-select in the Settings dialog).
  Legacy per-role sections (`{"senior": [...], "junior": [...]}`) and
  legacy top-level `plugins_senior`/`plugins_junior` keys are merged on
  read (dedup, order preserved) and dropped on the next save; the
  deprecated `TWO_BROTHERS_PLUGINS_SENIOR`/`_JUNIOR` env vars stay
  accepted as additive aliases merged into the shared set (never
  persisted). `PluginManager.toolsFor` now takes
  `(activeNames, workspace)`; `ctx.add_tool`'s `role` argument is still
  accepted for plugin-source compatibility but no longer scopes
  assignment, and `GET /api/plugins` reports `roles: ["shared"]`.
  `PUT /api/settings` still accepts the legacy per-role object (merged),
  so older clients/scripts keep working. Per-role plugin scoping is
  recorded as a future refinement in `docs/develop/BACKLOG.md`.
- **Bare `run --json` is an output mode, not a print-mode modifier**
  (consumer-journey fix, 2026-11-04): `--json` without an explicit
  `--mode print|json` now selects the machine-readable `--mode json`
  object (`{task, events, decision, usage, cost, rounds, errors}`) instead
  of printing the human transcript plus one final decision line. An
  explicit `--mode print --json` still narrows print mode to the decision
  object, and `--json` keeps composing with a cooperation mode
  (`--mode work --json`). `--help` documents `--json` on its own line
  instead of grouping it with `--verbose` under the print-mode note. The
  `TWO_BROTHERS_JSON` env var keeps its `PROTOCOL.md` contract (print the
  final decision as JSON on the last line) — only the flag changed.

## [0.1.0] - 2026-11-02

### Added

- **Core + execution tier ported from the Python implementation**
  (`python/two_brothers/`) to a publishable TypeScript npm package:
  protocol envelopes with tolerant `parse_model_output` → strict zod
  validation → sanitizing bridge; byte-stable transcript rendering
  (`[[TASK]]`/`[[/TASK]]`, "Context events:"); JSONL session store with
  flush-per-append, dense `seq`, and resume without re-appending history.
- **Provider layer:** mock provider at parity with Python, plus an
  OpenAI-compatible `fetch` client with a harness-owned retry loop
  (exponential backoff 2/4/8/16/30 s), abort-aware cancellation, per-attempt
  timeout, and usage tracking (input/output/cached tokens, model-call count).
- **Cooperation state machine** (`harness.ts`): senior consult → junior
  answer/proposal → senior verify (read-only tool slice) → senior review →
  junior revise loop → senior decision; confined workspace tools
  (read/list/search/write/edit/delete with unified diffs, symlink-aware root
  confinement), fail-closed permission manager with an operator approval
  broker, bounded cancellable shell runner (process-tree kill on Windows and
  POSIX); `tool:`/`verify:` evidence and usage snapshot in payloads.
- **CLI parity** (`run`/`chat`/`sessions`/`selftest`/`serve`) from the built
  `dist/`, byte-identical mock output vs the Python CLI including the
  `tokens:` usage footer; shebang-verified `two-brothers` bin.
- **Product shell** (server/runtime/settings tier, no new runtime deps):
  settings + secret stores (`settings_store.ts`, `secretbox.ts`; per-role +
  provider-preset persistence, DPAPI/`plain1:` sealed API keys, env-pinned
  values never persisted); worker-pool run manager with typed events,
  same-session serialization, cooperative stop, and JSONL runtime event
  sidecars; FastAPI-compatible HTTP + SSE server on plain `node:http`
  (sessions CRUD, background runs, mid-stream approvals, `/api/fs/browse`,
  static serving with SPA fallback); workspace registry + metadata sidecars.
- **MCP tool loading** (`mcp.ts`) on `@earendil-works/pi-mcp` with
  role-scoped server assignment (`shared`/`senior`/`junior`) feeding the
  tool-scope registry.
- **Context compaction** (`compaction.ts`) — pi-durable's algorithm
  ported onto the envelope format: cut-point selection that never loses
  the original task, plain-text transcript serialization (2000-char
  entry cap), and pi's pinned structured-summary prompt. Auto trigger
  when the rendered context passes `--compact-threshold <chars>` (with
  capped budgets so a compacted context lands under the threshold),
  one-shot `--compact`, `--compact-keep-recent <chars>` verbatim tail
  (default 40000), `TWO_BROTHERS_COMPACT*` env vars. The summary is
  produced by the configured provider (senior by default) and carried as
  a clearly-marked `message` envelope, so protocol envelopes and the
  session JSONL shape stay byte-valid; compacted sessions resume through
  the new temp-file + rename `SessionStore.rewrite()`. Fail-soft by
  contract: a summarization failure logs a warning and keeps the full
  context. Python has no compaction — a documented TS-first divergence.
- **E2E suites** (`e2e/`): connection probe, consult, work-with-approvals,
  resume, Python-parity, and server-over-HTTP suites — hermetic with a mock
  provider, SKIPs cleanly when the real-model endpoint is unreachable, and
  green against LM Studio on both the `.ts` sources and the built `dist/`.
- 313 unit tests on the core tier (+ settings/runtime/server/MCP/plugins/
  compaction coverage), all green; offline selftest is the fast gate.

### Changed

- `typescript/` remains the zero-dependency protocol reference; the
  publishable build is `tsc` → `dist/` (ES2022, Node ≥ 22.19, declarations on).
- `@earendil-works/pi-mcp` exact pin 1.4.0 → 1.5.0 (lockfile-reviewed;
  same `McpTimeoutError` / `McpRequestOptions.timeoutMs` surface; upstream
  fixes OAuth URL-scheme validation and an HTTP error-body leak).

## [0.0.1] - 2026-11-02

Publish preparation for the first npm release (supply-chain hardening, after
earendil-works/pi, MIT):

### Added

- `scripts/check-pinned-deps.mjs` (wired into the root `npm run check`):
  every runtime dependency of `packages/harness` must be an exact version.
- `scripts/check-runtime-deps.mjs` (wired into the root `npm run check`):
  every bare import in the built `dist/*.js` must be declared in
  `package.json` dependencies — no phantom imports, no missing deps.
- `scripts/tarball-smoke.mjs` (root `npm run check:tarball-smoke`, run
  manually pre-release): packs the tarball, installs it into a fresh temp
  dir, and smoke-runs `dist/selftest.js` (expects `SELFTEST: PASS`) and
  `dist/cli.js run "smoke" --provider mock` (expects exit 0 + `tokens:`
  footer).
- `.husky/pre-commit`: blocks `package-lock.json` commits unless
  `ALLOW_LOCKFILE_CHANGE=1` is set.
- This changelog.

[Unreleased]: https://github.com/nik1138/two-brothers-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nik1138/two-brothers-harness/releases/tag/v0.1.0
[0.0.1]: https://github.com/nik1138/two-brothers-harness/releases/tag/v0.0.1
