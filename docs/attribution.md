# Attribution

Two Brothers is released under the MIT license. The package ships the
authoritative third-party notice as [NOTICE](../NOTICE) (identical at the repo
root and in [packages/harness/NOTICE](../packages/harness/NOTICE)); this page is
a readable index of the MIT references and the code or ideas adopted from them.
If this page and `NOTICE` disagree, `NOTICE` wins.

The reference clones live under `research/vendor/` in a local checkout.
`research/` is **local-only**: it is gitignored (`.gitignore`), never committed,
and not published — the npm tarball's `files` list is `dist`, `shared`, `web`,
`README.md`, `LICENSE` and `NOTICE`. The clones are read-only references, not a
dependency or a shipped component.

## Vendored references

| Project | Upstream | License (from the clone's `LICENSE`) |
|---|---|---|
| pi | <https://github.com/earendil-works/pi> | MIT — Copyright (c) 2025 Mario Zechner |
| kimi-code | <https://github.com/MoonshotAI/kimi-code> | MIT — Copyright (c) 2026 Moonshot AI |
| opencode | <https://github.com/anomalyco/opencode> (`sst/opencode` redirects here) | MIT — Copyright (c) 2025 opencode |
| deepseek-harness | <https://github.com/deepseek-ai/deepseek-harness> | MIT — Copyright (c) 2026 DeepSeek |

## Code adapted from pi

All of these were adapted for this package; the module headers name the upstream
file and its MIT license, and `NOTICE` carries the required copyright and
permission text.

| Here | Upstream | What was ported |
|---|---|---|
| `packages/harness/src/provider.ts` | pi-ai `utils/retry.ts`, `utils/provider-retry.ts`, `utils/overflow.ts` | The ordered provider-error classification registry: retryable 408/409/429/5xx and transport errors, `retry-after-ms`/`Retry-After` parsing (capped at 120 s), bounded 0–25% backoff jitter, context-overflow detection (`ProviderContextOverflowError`), and non-retryable quota/billing failures. |
| `packages/harness/src/workspace.ts` | coding-agent `edit-diff.ts`, `file-mutation-queue.ts` | `normalizeForFuzzyMatch` (NFKC, trailing whitespace, smart quotes/dashes/spaces) and the robust-edit matching strategy; the per-path write/edit/delete mutation queue keyed by realpath. |
| `packages/harness/src/compaction.ts` | coding-agent `core/compaction/compaction.ts` | Cut-point selection, the 2000-char serialization cap, the pinned cold and update summarization prompts (verbatim), incremental `<previous-summary>` chaining, and the split-payload cut. |
| `packages/harness/src/mcp.ts` | coding-agent `extensions/mcp/tools.ts` | `createMcpToolName`: `mcp__<server>__<tool>` sanitizing, the 64-character cap, and a stable sha256 suffix on truncation/collision. The 20 KiB result cap follows pi's `MCP_OUTPUT_MAX_BYTES`. |
| `packages/harness/src/output.ts` | chord `output.ts` | Bounded head+tail output windows and ANSI/control-sequence sanitizing; reimplemented for whole strings, not copied. |

`SUMMARIZATION_PROMPT` and `UPDATE_SUMMARIZATION_PROMPT` in `compaction.ts` are
verbatim copies of pi's prompts, as recorded in `NOTICE`.

## Conventions adopted from the vendored references

No source code is copied from these references — only wire shapes and design
conventions, recorded in this index (most adapted modules also name their
upstream in a header comment). `NOTICE` changes only for a substantial block
(`NOTICE` is unchanged by the 2026-11-07 surface adaptations, the wave-23 ones
below, the wave-25 tab-title/signal design-only adaptations, and the wave-26
copy/title/notification, external-editor and fork-from-here ones — no block was
copied).

| Project | Here | What was adopted |
|---|---|---|
| kimi-code | `packages/harness/src/commands.ts`, `src/skills.ts`, `src/harness.ts` | The plugin command model (markdown templates), skills-root precedence (earlier root wins a name collision), and the `<skill-loaded>` body delivery as a `message` envelope from `"user"`. |
| opencode | `packages/harness/src/commands.ts`, `src/plugins.ts` | Markdown command files with a template body, `{path, options}` plugin entries, free-form plugin config, and the `execute.before` hook vocabulary. Our command catalogue stays flat; upstream also scans nested `command/` trees. |
| deepseek-harness | `packages/harness/src/runstream.ts`, `src/plugins.ts` | The NDJSON run-stream projection shape (commit-point records, bounded fields, terminal `result`) and the pre-execute tool hook in the shared hook set. |
| deepseek-harness | `packages/harness/src/spill.ts`, `src/harness.ts`, `src/mcp.ts`, `src/server.ts`, `src/cli.ts` | The bounded tool-output spill idea (`packages/spill`): the full text is persisted under a private root, the model gets a bounded preview plus a locator, and the retrieval policy stays with the consumer. Implemented locally as one random-id file per spill and a validated `spill_read` chunk reader; no Cordis service/plugin architecture or code copied. The opt-in age-based retention follows its local cleanup semantics (only validated regular files strictly older than the cutoff, symlinks skipped, fail-soft unlink counts) without the service architecture; the `spill stats`/`spill gc` CLI and the `serve --spill-retention-days` startup pass are local designs. |
| deepseek-harness | `packages/harness/src/workspace.ts` | The line-page read shape for `workspace_read_file` (`packages/api/workspace-files`): 1-based `offset`, a `limit` with a default/max page size, a page of lines, and honest `lines`/`eof` bookkeeping. Our streamed line scanner, character budget, clipping policy and `next_offset` are local; no byte-range/file-scope architecture or code copied. |
| kimi-code | `packages/harness/src/tui/view/approval.ts`, `web/src/components/ApprovalCard.vue`, the additive `ApprovalDetail` in `src/permissions.ts` | The workspace approval-panel shape: typed detail blocks (diff / file content / shell invocation), numbered decisions, `Esc` reject, a full-screen preview, and honest copy around the scope of a session-wide grant. Reimplemented locally on our own `RunApprovalBroker`; no block copied. |
| kimi-code | `web/src/folding.ts`, `web/src/components/ChatView.vue` | The step-summary shape: collapsing older completed-run tool/step rows into one muted summary line (our `… N tool calls · expand`, plus `in M runs` when a group spans several runs) while the active run and all conversation content stay open. Implemented locally; no code copied. |
| kimi-code | `web/src/components/WelcomeHero.vue` | The empty/welcome-state shape: workspace context, primary actions and starter suggestions for a session with no transcript (our starters only prefill the composer, never auto-send). Implemented locally. |
| deepseek-harness | `packages/harness/src/todos.ts`, `src/tui/view/todo.ts`, `web/src/runtime.ts`, `web/src/components/TodoPanel.vue` | The model-facing tool-todo idea: a whole-list snapshot of minimal `{content, status}` entries, last-write-wins, plus a bounded display panel with status markers and a hidden-count tail. Our tool, schema, events and panels are implemented locally (tolerant sanitize, no approval, no workspace access); no code copied. |
| deepseek-harness | `packages/harness/src/sessionlayout.ts` | The project/session directory layout (`<project>/<stem>/session.jsonl` + `meta.json` + `events.jsonl`), copy-first migration with identical-target adoption and conflict reporting, and per-session runtime sidecars. Implemented locally from the documented on-disk contract and the MIT reference; no code block copied. |
| deepseek-harness | `packages/harness/src/repeatguard.ts`, `src/harness.ts` | The advisory repeat-tool-call guard (`packages/guard/repeat-tool-reminder`): a per-call `(tool name, deep-key-sorted arguments)` consecutive chain, threshold escalation at 3/5/8, `*`-wildcard `include`/`exclude` scoping, transparent untracked tools, a reset on a new user message, and the gentle/detailed reminder shapes with a bounded argument preview. Reimplemented locally as a dependency-free helper wired into one tool loop; no Cordis plugin architecture, runtime/stream/protocol change or code block copied. |
| deepseek-harness, opencode | `packages/harness/src/instructions.ts`, `src/harness.ts` | Root-level `AGENTS.md` / `CLAUDE.md` workspace instructions (`packages/context/agent-instructions` and `packages/core/src/instruction-discovery.ts`): fixed candidate order, regular-files-only discovery directly under the root, trimmed-content de-duplication, bounded reads with explicit omission markers, and a quote-neutralized untrusted-guidance block appended last to both system prompts. Nested chains, imports, file-watch refresh and the Cordis/Effect service layers are deliberately not adopted; implemented locally with `node:fs`, no code copied. |
| kimi-code | `packages/harness/src/tui/keymap.ts`, `src/tui/view/statusbar.ts` | The status-bar footer slot/tip idea: a rotating discoverability tip plus a separate transient hint line, derived from one command registry so copy can never describe a missing binding. Our rotation is a deterministic turn counter with registry-derived chords, and the transient slot is priority-clipped; implemented locally, no code copied. |
| kimi-code | `web/src/tokens.css`, `web/src/style.css`, `web/src/main.ts` | The role-named semantic token vocabulary: surfaces by role, three foreground tiers, `border`/`border-strong`, intent accents with soft companions, dedicated diff add/remove and search-hit roles, and duration/ease/radius/space scales (from `apps/vis/web/src/theme.css` and the web bundle's `--color-*` layer). The curated subset, values and the light/dark mechanism are ours; no token block copied. |
| deepseek-harness, kimi-code | `packages/harness/src/permissions.ts`, `src/tui/app.ts`, `web/src/approvalPolicy.ts`, `web/src/components/settings/ApprovalPolicySection.vue` | The operator approval-mode idea: an explicit ask/read-only/edits/allow-all decision table, a persisted policy with a fail-closed default, and a visible destructive warning for the permissive mode, translated to our `PermissionPolicy`/`SettingsStore`/dialog surfaces. Implemented locally on our own approval broker; no code copied. |
| pi | `packages/harness/src/harness.ts`, `src/runtime.ts`, `src/server.ts`, `web/src/steering.ts`, `web/src/components/Composer.vue` | The steering/follow-up queue idea (`packages/agent/src/agent.ts` `steer`/`followUp`, `agent-loop.ts` steering drained between turns): operator input classified as steering takes effect after the current turn and is delivered one-at-a-time in order. Reimplemented locally as a bounded drain at the cooperation state-machine node boundaries and tool-loop iterations, transported as our own protocol `message` envelope; no agent-loop, queue-classification or session-format code copied. |
| pi | `packages/harness/src/tui/steering.ts`, `src/tui/app.ts`, `src/tui/keymap.ts` | The steering/follow-up idea extended to the TUI: a chord (and palette action) queues composer text for the running turn and applies it at the next step. Reuses our own bounded runtime queue/drain and copy; no agent-loop or queue-classification code copied. |
| pi | `packages/harness/src/session.ts` | Torn-tail tolerance in the session reader (`coding-agent/src/core/session-manager.ts`: `parseSessionEntryLine` skips a malformed line and `loadEntriesFromFile` appends a missing final newline). We ignore only a malformed **final** fragment, keep interior corruption a typed error, and make `--resume` repair atomically; no reading or repair code copied. |
| pi | `packages/harness/src/turnsignal.ts`, `src/cli.ts`, `src/shell.ts` | Signal-driven shutdown and tracked-child cleanup (`coding-agent/src/utils/shell.ts` `trackDetachedChildPid`/`killTrackedDetachedChildren`; `modes/interactive/interactive-mode.ts` SIGTERM/SIGHUP handlers and `killTrackedDetachedChildren()` before graceful shutdown). We adopt the signal-shutdown shape — abort the turn, wait a bounded cleanup, keep machine stdout clean — and keep our own shell tree kill; no code copied. |
| pi, kimi-code, deepseek-harness | `web/src/tabTitle.ts`, `web/src/App.vue` | The background-attention title convention: a status glyph plus session name in the title (pi's `titlebar-spinner` extension and `tui/src/terminal.ts` `setTitle`, which strips control characters), a bounded attention notification (kimi's `tui/utils/terminal-notification.ts`: title/body, OSC 9 with a BEL fallback, focus-conditioned once-per-key), and the `<session> - <product>` web tab shape (deepseek-harness `apps/web`, asserted in `apps/web/tests/smoke-real.e2e.ts`). Our `▶`/`!`/`(failed)`/`(N)` grammar and unread rule are local; no code copied. |
| pi | `packages/harness/src/tui/copytext.ts`, `src/tui/clipboard.ts`, `src/tui/keymap.ts` | The copy-last-reply idea: a fixed chord copies the newest completed assistant reply, with a native clipboard first and an OSC 52 fallback for environments with no OS clipboard (pi `coding-agent/src/utils/clipboard.ts` `copyToClipboard` and `modes/interactive/interactive-mode.ts`'s `app.message.copy`, default `ctrl+x`). Our decision/senior selection, plain-text extraction, transport ordering, palette/help registration and OSC-52-only notice are local; no code copied. |
| pi, kimi-code | `packages/harness/src/tui/attention.ts`, `src/tui/terminal.ts`, `src/tui/app.ts` | The terminal-attention idea: an OSC 0 window title carrying session/run state (pi `tui/src/terminal.ts` `setTitle` strips control characters; `interactive-mode.ts` composes app/session/cwd) restored on exit, plus one OSC 9 notification with a BEL fallback on a parked approval (kimi `tui/utils/terminal-notification.ts`: sanitized bounded text, OSC 9, BEL fallback, tmux DCS passthrough). Our title grammar, restore rule and once-per-approval trigger are local; no code copied. |
| pi, kimi-code | `packages/harness/src/tui/externaleditor.ts` | The external-editor convention: `$VISUAL`/`$EDITOR` resolution with a platform notepad fallback, a temp draft file, inherited stdio and read-back on a clean exit (pi `coding-agent` external-editor handling; kimi's composer editor flow). Our PATH/PATHEXT resolution, workspace binary-planting refusal, `.cmd`/`.bat` wrapper, 256 KiB bound and terminal suspend/resume are local; no code copied. |
| pi-ai | `packages/harness/src/provider.ts` | The Anthropic prompt-cache breakpoint placement (`api/anthropic-messages.ts`: `getCacheControl`, system text-block markers, last-tool marker, newest-turn marker). Reimplemented locally (~20 lines) for this adapter's merged-system and tool-loop shapes; no code copied. |
| opencode | `packages/harness/src/workspacehistory.ts` | The content-addressed capture and per-file restore/preview model for run-scoped workspace edit undo (`packages/core/src/snapshot.ts`, `session/revert.ts`). The git shadow-tree machinery is deliberately not vendored: our store is a plain session side artifact with hash-verified pre/post images; design only, no code copied. |
| kimi-code, opencode | `packages/harness/src/sessionrewind.ts`, `src/sessionfork.ts`, `src/metadata.ts`, `web/src/sessionFork.ts` | The conversation-undo cut rules (`agent-core-v2/src/agent/undo/undoService.ts`, `contextMemory/contextOps.ts` `computeUndoCut`, the compaction floor and honest requested-vs-undoable reporting) and the fork UX (`docs/en/guides/sessions.md` `/fork`; opencode `Session.fork` boundary before/through — wave 26 adds the transcript's fork-at-this-message `{seq}` entry point on the same prefix-copy model) translated to a flat dense-`seq` JSONL prefix copy with a local `parent` sidecar link. Design only, no code copied. |
| pi | `packages/harness/src/sessionsearch.ts` (`sessionToHtmlString`) | The self-contained single-file session export inspiration (`coding-agent/src/core/export-html`: inlined template/CSS/JS, vendored highlight.js/marked). The templates and bundled third-party libraries were not copied: our renderer is hand-rolled HTML with an inline stylesheet and escaped plain text; no code copied. |
| deepseek-harness, opencode | `web/src/messageQuote.ts`, `web/src/components/ChatView.vue`, `web/src/components/Composer.vue` | The message-quote idea: a selection-aware transcript action that falls back to the whole message and appends ordinary Markdown (one `> ` prefix per line) to the composer, from deepseek-harness `packages/session/message-quotes` (`quote-text.ts`, `QuoteSelection.tsx`) and opencode's `SessionUserComment` quote shape (`packages/session-ui/src/actions.ts`). Our block formatting, 4 000-character cap with truncation marker, surrogate-safe cut, append-only draft semantics and selection-intersection rule are local; no code copied. |

## Other MIT references

`packages/harness/src/tui/text.ts` follows the grapheme/width rules of
`string-width` v7 and adapts `is-fullwidth-code-point` v5 (both MIT, Sindre
Sorhus). Neither package is vendored; the rules are implemented locally.

`packages/harness/src/tui/markdown.ts` follows the block/inline model and
width handling of pi's TUI Markdown component
(`packages/tui/src/components/markdown.ts`, MIT, Copyright (c) 2025 Mario
Zechner). It is implemented locally without `marked` and emits the same
grapheme/width-safe plain rows as the rest of the TUI.

`packages/harness/src/tui/transcript.ts` follows the wrap-then-slice visual-row
truncation approach of pi's `visual-truncate.ts` (coding-agent
`modes/interactive/components/`, MIT, Copyright (c) 2025 Mario Zechner) for
collapsed tool-result previews: text is wrapped to the render width first, the
preview budget counts visual rows rather than logical lines, and the hidden
count is exact. The implementation is local (no pi-tui dependency, no copied
block); a point-of-use provenance comment names the upstream file.

`@earendil-works/pi-mcp` 1.5.0 is a runtime dependency (MIT, Copyright (c) 2025
Mario Zechner). It is installed from npm, not vendored.
