# AGENTS.md — `web/src/`

Local map for the Vue app sources. Parent rules: `../AGENTS.md`; root rules:
`../../AGENTS.md`.

## What lives here

- `App.vue`, `main.ts`, `style.css`, `tokens.css` — shell and the design-token
  layer.
- `api.ts`, `types.ts` — backend client and API/protocol types.
- Pure projection/model modules: `chat.ts` (envelopes → group chat),
  `runtime.ts` (runtime events → tool/approval timeline), `markdown.ts`,
  `find.ts`, `search.ts`, `streaming.ts`, `sessionStatus.ts`, `drafts.ts`,
  `palette.ts`, `mentions.ts`, `composerKeys.ts`, `keybindings.ts`,
  `providerSettings.ts`, `themeMode.ts`, `density.ts`, and the other small
  persisted-state helpers.
- `components/` — Vue components (dialogs, sidebar, chat, composer, settings);
  follow the component and class-name rules in `../AGENTS.md`.

## Boundaries

- Frontend only. Backend routes live in `packages/harness/src/server.ts`;
  protocol shapes come from `PROTOCOL.md` and `types.ts`.
- Do not add npm packages beyond the approved list in `../AGENTS.md`; use
  tree-shaken `naive-ui` imports.
- Do not edit `../dist/` or `packages/harness/web/` (generated/packaged copies).

## Invariants and hazards

- `chat.ts` is the **only** place protocol payloads are interpreted; keep
  projections pure and incremental (fresh objects, no in-place mutation).
- `tokens.css` is the token home; raw colours belong only in `theme.ts`.
  Class names are global — a Settings section must not reuse sidebar/footer
  classes.
- Stacked dialogs must ignore `mask-click` events from other dialogs via
  `modal.ts`.
- When a protocol envelope or backend runtime event changes, update
  `types.ts` in the same change.
- `npm run build` (`vue-tsc` + Vite) is the type/template gate; `npm test`
  does not type-check `.vue` files.

## Commands

```powershell
# terminal 1 (from the repo root) — backend for npm run dev, serves /api on :8600
cd packages/harness
node dist/cli.js serve --port 8600 --sessions-dir sessions

# terminal 2 (from the repo root)
cd web
npm run dev
npm test
npm run build
```

Workflow: `../../AGENTS.md` ("Subagent Lanes").
