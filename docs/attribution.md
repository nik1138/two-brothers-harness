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
| `packages/harness/src/provider.ts` | pi-ai `utils/retry.ts`, `utils/provider-retry.ts`, `utils/overflow.ts` | The ordered provider-error classification registry: retryable 408/409/429/5xx and transport errors, `Retry-After` parsing (capped at 120 s), context-overflow detection (`ProviderContextOverflowError`), and non-retryable quota/billing failures. |
| `packages/harness/src/workspace.ts` | coding-agent `edit-diff.ts`, `file-mutation-queue.ts` | `normalizeForFuzzyMatch` (NFKC, trailing whitespace, smart quotes/dashes/spaces) and the robust-edit matching strategy; the per-path write/edit/delete mutation queue keyed by realpath. |
| `packages/harness/src/compaction.ts` | coding-agent `core/compaction/compaction.ts` | Cut-point selection, the 2000-char serialization cap, the pinned cold and update summarization prompts (verbatim), incremental `<previous-summary>` chaining, and the split-payload cut. |
| `packages/harness/src/mcp.ts` | coding-agent `extensions/mcp/tools.ts` | `createMcpToolName`: `mcp__<server>__<tool>` sanitizing, the 64-character cap, and a stable sha256 suffix on truncation/collision. The 20 KiB result cap follows pi's `MCP_OUTPUT_MAX_BYTES`. |
| `packages/harness/src/output.ts` | chord `output.ts` | Bounded head+tail output windows and ANSI/control-sequence sanitizing; reimplemented for whole strings, not copied. |

`SUMMARIZATION_PROMPT` and `UPDATE_SUMMARIZATION_PROMPT` in `compaction.ts` are
verbatim copies of pi's prompts, as recorded in `NOTICE`.

## Conventions adopted from kimi-code, opencode and deepseek-harness

No source code is copied from these three — only wire shapes and design
conventions, recorded in this index (most adapted modules also name their
upstream in a header comment). `NOTICE` changes only for a substantial block
(`NOTICE` is unchanged by the 2026-11-07 surface adaptations below).

| Project | Here | What was adopted |
|---|---|---|
| kimi-code | `packages/harness/src/commands.ts`, `src/skills.ts`, `src/harness.ts` | The plugin command model (markdown templates), skills-root precedence (earlier root wins a name collision), and the `<skill-loaded>` body delivery as a `message` envelope from `"user"`. |
| opencode | `packages/harness/src/commands.ts`, `src/plugins.ts` | Markdown command files with a template body, `{path, options}` plugin entries, free-form plugin config, and the `execute.before` hook vocabulary. Our command catalogue stays flat; upstream also scans nested `command/` trees. |
| deepseek-harness | `packages/harness/src/runstream.ts`, `src/plugins.ts` | The NDJSON run-stream projection shape (commit-point records, bounded fields, terminal `result`) and the pre-execute tool hook in the shared hook set. |
| kimi-code | `packages/harness/src/tui/view/approval.ts`, `web/src/components/ApprovalCard.vue`, the additive `ApprovalDetail` in `src/permissions.ts` | The workspace approval-panel shape: typed detail blocks (diff / file content / shell invocation), numbered decisions, `Esc` reject, a full-screen preview, and honest copy around the scope of a session-wide grant. Reimplemented locally on our own `RunApprovalBroker`; no block copied. |
| kimi-code | `web/src/folding.ts`, `web/src/components/ChatView.vue` | The step-summary shape: collapsing older completed-run tool/step rows into one muted summary line (our `… N tool calls · expand`, plus `in M runs` when a group spans several runs) while the active run and all conversation content stay open. Implemented locally; no code copied. |
| kimi-code | `web/src/components/WelcomeHero.vue` | The empty/welcome-state shape: workspace context, primary actions and starter suggestions for a session with no transcript (our starters only prefill the composer, never auto-send). Implemented locally. |
| deepseek-harness | `packages/harness/src/todos.ts`, `src/tui/view/todo.ts`, `web/src/runtime.ts`, `web/src/components/TodoPanel.vue` | The model-facing tool-todo idea: a whole-list snapshot of minimal `{content, status}` entries, last-write-wins, plus a bounded display panel with status markers and a hidden-count tail. Our tool, schema, events and panels are implemented locally (tolerant sanitize, no approval, no workspace access); no code copied. |

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
