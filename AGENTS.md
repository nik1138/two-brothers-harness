# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

**Two Brothers** is a harness for cooperation between two sibling agents: a
**senior** (the older brother — experienced and level-headed, the arbiter) and
a **junior** (the younger brother — brave and determined). Both share **one
common context**, have **different system prompts**, and exchange **structured
messages**. The senior consults the junior, may delegate work to it, and makes
the final decision.

This is not subagents in the usual sense — it is **parallel models with
explicit roles** cooperating as peers within a single context.

**The implementation is the TypeScript npm package** —
`packages/harness/` (`@two-brothers/harness`), in the style of pi /
deepseek-harness: a TypeScript cooperation core with a plain `node:http`
server (`node dist/cli.js serve`), runtime manager,
settings/secrets, MCP with role scoping, and a curated runtime dependency
list. See `docs/history/ts-rewrite-plan.md` (the port plan and its history).
New features, hardening, and protocol work land here — the shipped artifact is
TypeScript on npm.

One other tree shares the protocol contract (`PROTOCOL.md`) but is **not**
where product work happens:

- `typescript/` — **zero-dependency reference implementation** of
  `PROTOCOL.md` (no npm packages, native type stripping). It documents the
  protocol contract; it is not modified by feature work.

The original Python prototype was removed from the repository on 2026-11-04;
its history is in git history, and the captured `SPARK-TRANSCRIPT.md` /
`LMSTUDIO-TRANSCRIPT.md` runs remain as evidence.

## Repository Layout

| Path | Contents |
|---|---|
| `PROTOCOL.md` | the main message contract (root-level; code comments cite its sections by number — do not move or renumber it without updating `packages/harness/` and `typescript/`) |
| `DESIGN.md` | why this is cooperation, not subagents |
| `shared/` | shared system prompts (`prompts.json`) and JSON Schema (`protocol.schema.json`) |
| `typescript/` | zero-dependency TypeScript protocol reference |
| `packages/harness/` | the TypeScript package (npm; cooperation core + server + runtime + settings + MCP + plugins + skills + TUI) |
| `web/` | local single-user web workspace (Vue 3 + Vite + TS); `npm run build` must keep passing; the package tarball ships a copy of the build |
| `e2e/` | browser E2E (own package; Playwright drives the system Edge headless) |
| `plugins/` | local plugin modules (`register(ctx)` tool registration; see `docs/plugins.md`) — the example `notes.mts` ships with the repo |
| `scripts/` | `smoke-test.ps1` — offline gate (TypeScript package + reference + web tests/build); `e2e-test.ps1` — browser E2E runner |
| `docs/` | documentation, one flat set by topic; `docs/README.md` is the index (`quickstart.md`, `cli-reference.md`, `plugins.md`, `testing.md`, `backlog.md`, `design-review.md`) |
| `docs/history/` | historical records, content frozen: `ts-rewrite-plan.md`, `cli-audit.md`, `web-ui-audit.md`, `handoff.md` |
| `research/` | **local-only, gitignored** — research notes + vendored MIT reference clones (pi, kimi-code, deepseek-harness, opencode); never committed or published |
| `SPARK-TRANSCRIPT.md` | captured real-model cooperation cycle (evidence) |
| `LMSTUDIO-TRANSCRIPT.md` | LM Studio run evidence (`spark-x2.6-4b@q4_k_m` + `lfm3-1.7b`) |

Subdirectories with their own agent guidance: `typescript/AGENTS.md`,
`web/AGENTS.md`.

## Hard Rules

1. **The protocol is defined in `PROTOCOL.md` and `shared/protocol.schema.json`.**
   A protocol change means: update PROTOCOL.md → update the JSON Schema →
   update the TypeScript package (`packages/harness/`) and its test suite →
   keep the `typescript/` reference and `shared/prompts.json` copies in sync.
2. **`typescript/` stays zero-dependency** — do not add npm packages or a build
   step to it. **Carve-out:** `packages/harness/` is the publishable TypeScript
   package (tsc build to `dist/`); it may carry devDependencies and a curated,
   justified runtime dependency list recorded in
   `docs/history/ts-rewrite-plan.md` (currently `zod` for payload validation and
   `@earendil-works/pi-mcp` for MCP).
3. **All documentation is written in English.** Docs live in one flat `docs/`
   set organized by topic (`docs/README.md` is the index); historical records
   go in `docs/history/` and are not rewritten. Use "Two Brothers" for the
   product, `two-brothers` for commands, and `@two-brothers/harness` for the
   package.
4. **Validation is tolerant at the boundary.** Model output is parsed with
   `parseModelOutput` (strips markdown fences / surrounding text) and
   `sanitizePayload` (drops unknown fields, coerces types, fills defaults).
   Keep this behavior when touching the protocol layer.
5. **The rendered transcript is part of the contract.** The context markers
   (`[[TASK]]`/`[[/TASK]]`, "Context events:") are user-visible strings sent to
   models; keep them byte-stable across the package and the `typescript/`
   reference, including selftests.
6. **`web/` is a Vue 3 + Vite app.** `npm run build` (to `web/dist`) must keep
   passing; the TypeScript server serves the built app (repo `web/dist` in a
   checkout, the packaged copy in the npm tarball).

## Common Commands

```powershell
# full offline gate (TypeScript package gates + reference selftest + web tests/build);
# pwsh is not installed on this machine — use Windows PowerShell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1

# browser E2E (Playwright + system Edge; needs packages/harness built and
# web/dist — scripts/e2e-test.ps1 builds the web app and installs e2e deps)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1

# one-command pre-push release rehearsal (clean tree -> build + npm run check ->
# smoke -> tarball smoke -> pack:check -> browser E2E; PASS/FAIL + timings,
# exit 1 on any failure; -SkipBrowser / -SkipTarball for fast iterations)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release-rehearsal.ps1

# TypeScript package (packages/harness — the implementation, npm package)
cd packages/harness
npm install
npm run build                # tsc -> dist/
npm test
node dist/cli.js run "..." --provider mock
node dist/cli.js serve [--port 8600] [--sessions-dir sessions]   # TS backend for web/
npm run check                # pinned-deps + runtime-deps checks (repo root)
node scripts/tarball-smoke.mjs                                   # pack+install smoke (repo root)

# web workspace
cd web
npm install
npm run dev                  # Vite dev server (proxies /api to :8600)
npm run build                # must keep passing; outputs web/dist

# zero-dependency protocol reference
cd typescript
node src/selftest.ts
node tests/run-all.ts

# offline demo run (TS package)
node dist/cli.js run "Plan a migration from Redis to Valkey" --provider mock
```

## Testing Notes

- `selftest` is the fastest offline gate (`node dist/selftest.js` in
  `packages/harness` after a build; `node src/selftest.ts` in `typescript/`).
- Package tests: `npm test` (in-process `node:test` runner) and
  `npm run test:spawn` (`node --test tests/`). Hermetic CLI E2E:
  `node e2e/cli.ts` and `node e2e/cli.ts --dist`.
- Live/opt-in E2E: `packages/harness/e2e/` (`npm run test:e2e`,
  `npm run test:e2e:dist`) against LM Studio; the hermetic server-status and
  prompt-audit suites run even when no endpoint is reachable.
  Browser E2E: `e2e/` + `scripts/e2e-test.ps1` (Playwright on the system Edge,
  headless, TypeScript backend). All hermetic and offline; see
  `docs/testing.md`.
- CI (see `docs/testing.md`): `.github/workflows/ci.yml` runs the hermetic
  gates on an ubuntu matrix (Node 22/24) and a Windows leg (Node 24 on
  `windows-latest`); the Node-22-only release rehearsal runs once on ubuntu.
- Session persistence: `--session-file` writes every envelope as JSONL
  (flushed immediately); `--resume` rebuilds the context with dense `seq`
  numbering. Covered by `tests/session.test.ts`. The web workspace adds
  sidecars: `*.meta.json` (title, workspace link) and
  `sessions/runtime/*.events.jsonl` (tool/approval events). Run records and
  pending approvals are in-memory only; role settings persist to
  `sessions/settings.json` (keys encrypted at rest).
- Known gaps (see `docs/design-review.md`): WAN fault injection and long soaks
  are deliberately manual/not in the offline gates (a hermetic scale suite
  covers large sessions and transcripts, 200-session listings, concurrent
  runs and repeated compaction; the smoke gate and CI run a loopback
  real-TCP fault-injection runner for retry/timeout/overflow/quota, and
  opt-in manual real-network runners exist — `packages/harness/e2e/load.ts`
  for CLI cooperation cycles and `packages/harness/e2e/serve-load.ts` for the
  serve RunManager/worker pool/queue — with recorded LM Studio evidence).
  Timeout and shutdown behavior is covered hermetically (provider
  retry/timeout registry, `run_shell` timeout clamp, `serve` shutdown grace);
  real-network coverage exists only in the opt-in live layers
  (`packages/harness/e2e` against LM Studio, the browser `real` scenario) —
  every other suite is hermetic and offline (mock/scripted providers).

## Docs Map

- Index: `docs/README.md`
- User docs: `docs/quickstart.md`, `docs/cli-reference.md`
- Developer docs: `docs/testing.md`, `docs/design-review.md`, `docs/plugins.md`,
  `docs/release.md`, `docs/backlog.md`
- History (content frozen): `docs/history/ts-rewrite-plan.md`,
  `docs/history/cli-audit.md`, `docs/history/web-ui-audit.md`,
  `docs/history/handoff.md`
- Contracts: `PROTOCOL.md`, `DESIGN.md`, `shared/protocol.schema.json`