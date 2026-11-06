# AGENTS.md — `web/`

Guidance for coding agents working on the web workspace. Project overview and
rules live in `../AGENTS.md`.

## What this is

A **Vue 3 + Vite + TypeScript** app that turns Two Brothers into a local,
single-user coding workspace. The only conversation view is a three-party
group chat — **Operator / Senior / Junior** — projected from protocol
envelopes. It talks to the backend HTTP + SSE API served by the TypeScript
package on plain `node:http`:
sessions/workspaces/settings via `/api/sessions*` and `/api/workspaces*`,
async run progress and operator approvals via `/api/runs*` (SSE with
`?after=N` reconnect). The backend serves the built app at `/` when present —
the packaged `packages/harness/web` copy first, then the repo's `web/dist`.
The backend is the TypeScript server in `packages/harness`:

- `cd packages/harness && node dist/cli.js serve --port 8600 --sessions-dir sessions`

## Layout

- `src/App.vue` — shell: session sidebar (workspace-grouped sessions,
  bottom-left Settings entry and theme selector, mobile drawer below a
  breakpoint), chat, composer, run follow/stop, dialogs, command palette
  (`Ctrl+K`/`Cmd+K`); `src/palette.ts` — pure palette item building/scoring/
  filtering; `src/components/CommandPalette.vue` — the combobox dialog
  (grouped results, `aria-activedescendant`, focus restore via `AppDialog`)
- `src/components/` — `Sidebar`, `SessionGroup`/`SessionRow` (workspace
  groups), `SidebarFooter` (bottom-left Settings plus a Light/Dark/System
  segmented theme selector), `ChatView`, `Composer`,
  `ToolActivity`, `ApprovalCard` (docked approvals), `DiffView`/`DiffReview`
  (changed-file review), `CommandResult`, `PromptAudit`, `ContextMeter`,
  `UsageFooter`, `SettingsDialog` (Senior/Junior roles + provider presets,
  `settings/` sections), `WorkspaceDialog` + `WorkspaceFinder` (the single
  workspace picker; fs explorer fed by `/api/fs/browse`), `NewSessionDialog`,
  `AppDialog`/`AppIcon`, `ErrorToast`
- `src/api.ts` — backend client; `src/types.ts` — API types mirroring the
  protocol envelopes (`PROTOCOL.md`) and runtime events; `src/modal.ts` —
  stacked-modal mask-click guard (naive-ui fires `mask-click` for clicks
  inside another stacked dialog — every dialog's mask-click handler must
  ignore those)
- `src/chat.ts` — envelopes → group-chat projection (the only place payloads
  are interpreted), incremental with fresh-object replacement; `src/runtime.ts`
  — runtime events → tool/approval items, timeline merge, changed-file
  collection (also incremental); `src/markdown.ts` — dependency-free Markdown
  subset parser (typed block/inline tree, no HTML output, URL allowlist, hard
  bounds) rendered by `ChatView`; `src/themeMode.ts` — persisted
  light/dark/system theme pin (`data-theme` on `<html>`); `src/drafts.ts` —
  per-session unsent composer drafts in a versioned, bounded localStorage blob
  (injectable `StorageLike`, no DOM dependency; `Composer` debounces writes and
  flushes on session switch/unmount); `src/sessionStatus.ts` — pure sidebar row
  status derivation (live / waiting / failed / unread / read) plus a bounded,
  persisted last-seen map for unread dots; `src/recents.ts` — bounded MRU
  workspace ids in a versioned, fail-soft localStorage list;
  `src/density.ts` — persisted Comfortable/Compact spacing preference
  (`data-density` on `<html>`, injectable storage, applied pre-paint in
  `index.html`, exposed from Settings → Appearance and the palette)
- `vite.config.ts` — dev proxy `/api` → `http://127.0.0.1:8600`

## Rules specific to this tree

1. **Dependencies (owner decision 2026-10-31):** `vue`, `vite`,
   `@vitejs/plugin-vue`, `typescript`, `vue-tsc`, plus **`naive-ui`** as the
   component library. Do not add further npm packages. Use plain
   `import { NButton, ... } from 'naive-ui'` — Vite tree-shakes it; no
   auto-import plugins. Match the app theme via `theme-overrides`/tokens,
   not global CSS resets.
2. **`npm run build` must keep passing** (outputs `dist/`). The backend serves
   that build, so a broken build breaks the product, not just CI. `npm test`
   runs the chat/timeline projection tests, the draft-store tests, the
   command-palette build/score/filter tests, and the session-status/recents
   stores (plain
   `node --test` via `tests/register-ts.mjs`); keep it green too — the smoke
   test calls it. Run test files individually (`node --import
   ./tests/register-ts.mjs --test tests/drafts.test.ts`) when the sandbox
   blocks spawned test runners.
3. `npm run dev` proxies `/api` to the backend — start it first:

   - `cd packages/harness && node dist/cli.js serve --port 8600 --sessions-dir sessions`
4. Frontend types must stay aligned with `PROTOCOL.md` envelope shapes and the
   backend's runtime-event shapes; when either changes, update `src/types.ts`
   in the same change.
