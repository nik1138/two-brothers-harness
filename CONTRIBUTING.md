# Contributing

Two Brothers is developed as a TypeScript product; the zero-dependency
`typescript/` reference is the only other tree. This page covers setup, the
gates a pull request must keep green, and where things live. Working rules for
coding agents (and the full layout/command list) are in [`AGENTS.md`](AGENTS.md).

## Prerequisites

| Component | Version | Needed for |
|---|---|---|
| Node.js | ≥ 22.19 | `packages/harness` — build, tests, gates (also the npm package's `engines` floor); `typescript/` and `web/` run on the same Node |

## Setup

```bash
git clone https://github.com/nik1138/two-brothers-harness.git
cd two-brothers-harness/packages/harness
npm install
npm run build          # tsc -> dist/
```

The web workspace is a separate npm project:

```bash
cd two-brothers-harness/web
npm install
```

## Gates

Every pull request must keep these green. CI runs the package gates on Node 22
and 24.

```bash
cd packages/harness
npm run typecheck
npm test
npm run build && node dist/selftest.js
node e2e/cli.ts
npm run pack:check
```

```bash
cd web
npm run build
```

Notes:

- `npm run pack:check` runs `publint` and `attw` against the packed tarball, so
  build first.
- CI additionally runs `npm run test:spawn` and an offline mock run; the root
  `npm run check` enforces the exact dependency pins and the runtime-dependency
  list.
- Browser E2E (`scripts/e2e-test.ps1`, Playwright on the system Edge) is not
  part of the PR gate, but changes to the web workspace should keep it passing.

## Repository layout

| Path | Contents |
|---|---|
| [`packages/harness/`](packages/harness/) | **the product** — publishable TypeScript package (`@two-brothers/harness`) and the server |
| [`web/`](web/) | Vue 3 + Vite workspace, served by the TypeScript server |
| [`typescript/`](typescript/) | zero-dependency reference implementation of the protocol |
| [`shared/`](shared/) | system prompts (`prompts.json`) and `protocol.schema.json` |
| [`e2e/`](e2e/) | browser E2E (Playwright drives the system Edge headless) |
| [`plugins/`](plugins/) | example plugin modules (`register(ctx)` tool registration) |
| [`scripts/`](scripts/) | smoke-test and browser E2E runner scripts |
| [`docs/`](docs/) | one flat documentation set, indexed by [`docs/README.md`](docs/README.md); historical records in [`docs/history/`](docs/history/) |

## Where to start reading

- [`docs/plugins.md`](docs/plugins.md) — plugin authoring:
  tools, scopes, hooks, MCP servers, per-plugin options.
- [`docs/testing.md`](docs/testing.md) — suites in each tree
  and how to run them.
- [`docs/history/ts-rewrite-plan.md`](docs/history/ts-rewrite-plan.md) — the
  port plan and the dependency ledger.

## Protocol changes

The contract is [`PROTOCOL.md`](PROTOCOL.md) plus
[`shared/protocol.schema.json`](shared/protocol.schema.json). A protocol change
means updating the contract, the schema, the TypeScript package and its test
suite together, and keeping the `typescript/` reference and both
`shared/prompts.json` copies in sync.

## Pull requests

- One focused change per pull request; describe what changed and which gates
  you ran.
- All documentation is in English.
- `research/` is local-only and gitignored (research notes and vendored
  reference clones). It is not accepted in pull requests.
- Security reports do not belong in issues — see [`SECURITY.md`](SECURITY.md).