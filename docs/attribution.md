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
conventions, each with an attribution comment at the point of use (see
`NOTICE`).

| Project | Here | What was adopted |
|---|---|---|
| kimi-code | `packages/harness/src/commands.ts`, `src/skills.ts`, `src/harness.ts` | The plugin command model (markdown templates), skills-root precedence (earlier root wins a name collision), and the `<skill-loaded>` body delivery as a `message` envelope from `"user"`. |
| opencode | `packages/harness/src/commands.ts`, `src/plugins.ts` | Markdown command files with a template body, `{path, options}` plugin entries, free-form plugin config, and the `execute.before` hook vocabulary. Our command catalogue stays flat; upstream also scans nested `command/` trees. |
| deepseek-harness | `packages/harness/src/runstream.ts`, `src/plugins.ts` | The NDJSON run-stream projection shape (commit-point records, bounded fields, terminal `result`) and the pre-execute tool hook in the shared hook set. |

## Other MIT references

`packages/harness/src/tui/text.ts` follows the grapheme/width rules of
`string-width` v7 and adapts `is-fullwidth-code-point` v5 (both MIT, Sindre
Sorhus). Neither package is vendored; the rules are implemented locally.

`@earendil-works/pi-mcp` 1.5.0 is a runtime dependency (MIT, Copyright (c) 2025
Mario Zechner). It is installed from npm, not vendored.
